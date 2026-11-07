package dev.prismo.app

import android.content.Context
import android.util.Base64
import android.util.Log
import computer.iroh.BiStream
import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointAddr
import computer.iroh.EndpointId
import computer.iroh.EndpointOptions
import computer.iroh.IrohException
import computer.iroh.IrohErrorKind
import computer.iroh.RecvStream
import computer.iroh.SendStream
import computer.iroh.presetN0
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.TimeoutCancellationException
import okhttp3.Call
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSource
import okio.Source
import okio.Timeout
import okio.buffer
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import kotlin.math.min

private val ALPN = "prismo/git/1".toByteArray(StandardCharsets.UTF_8)
private const val MAX_RESPONSE = 160L * 1024 * 1024

internal fun asIrohIOException(error: Exception): IOException =
    if (error is IOException) error else IOException("Iroh 통신 중 오류가 발생했습니다.", error)

// A stream reset affects one request; a stalled response or a connection-layer
// error invalidates the cached session for future requests. Existing users
// retain ownership until their individual streams have been released.
internal fun isConnectionError(kind: IrohErrorKind): Boolean = when (kind) {
    IrohErrorKind.CONNECTION, IrohErrorKind.CONNECT, IrohErrorKind.CLOSED,
    IrohErrorKind.RELAY, IrohErrorKind.TIMEOUT -> true
    else -> false
}

internal fun shouldRetireSession(error: Exception): Boolean =
    error is TimeoutCancellationException ||
        error is IrohException && isConnectionError(error.kind())

// A retry runs after the preceding attempt's timeout scope has ended.
internal suspend fun <T> withHeaderRetry(
    method: String, timeout: Long, attempt: suspend () -> T,
    onFailure: (Exception) -> Boolean
): T {
    var retries = if (method == "GET") 1 else 0
    while (true) {
        try {
            return withTimeout(timeout) { attempt() }
        } catch (error: Exception) {
            if (!onFailure(error) || retries == 0) throw error
            retries--
        }
    }
}

private class ConnectionSession(val handle: Connection) {
    var users = 0
    var cached = true
}

private class RequestStream(
    val stream: BiStream,
    val session: ConnectionSession,
    private val cleanup: CoroutineScope,
    private val retire: (ConnectionSession) -> Unit,
    private val release: (ConnectionSession) -> Unit
) {
    // The UniFFI BiStream accessors allocate independently owned native handles.
    // Acquire each half once and release all three objects as one request owner.
    val receiver: RecvStream = stream.recv()
    val sender: SendStream = try {
        stream.send()
    } catch (error: Exception) {
        receiver.close()
        throw error
    }
    private val guard = Any()
    private var operations = 0
    private var ending = false
    private var cleanupDone = false
    private var released = false

    suspend fun <T> use(block: suspend (RequestStream) -> T): T {
        synchronized(guard) {
            if (ending) throw IOException("요청 스트림이 종료되었습니다.")
            operations++
        }
        try {
            return block(this)
        } finally {
            synchronized(guard) { operations-- }
            finishIfReady()
        }
    }

    fun end(interrupted: Boolean, retireSession: Boolean) {
        synchronized(guard) {
            if (ending) return
            ending = true
            cleanupDone = !interrupted
        }
        if (retireSession) retire(session)
        if (interrupted) {
            cleanup.launch {
                try { receiver.stop(0uL) } catch (_: Exception) {}
                try { sender.reset(0uL) } catch (_: Exception) {}
                synchronized(guard) { cleanupDone = true }
                finishIfReady()
            }
        } else {
            finishIfReady()
        }
    }

    private fun finishIfReady() {
        val shouldRelease = synchronized(guard) {
            if (!ending || !cleanupDone || operations != 0 || released) false
            else { released = true; true }
        }
        if (!shouldRelease) return
        try { receiver.close() } catch (_: Exception) {}
        try { sender.close() } catch (_: Exception) {}
        try { stream.close() } catch (_: Exception) {}
        release(session)
    }
}

private class ActiveRequest {
    val job = Job()
    private val stream = AtomicReference<RequestStream?>()

    fun attach(opened: RequestStream) {
        if (!job.isActive) {
            opened.end(interrupted = true, retireSession = false)
            throw CancellationException("Request cancelled")
        }
        // A request has only one active stream. Retries must finish the previous
        // attempt before attaching the next; never silently replace an owner.
        if (!stream.compareAndSet(null, opened)) {
            opened.end(interrupted = true, retireSession = false)
            throw IllegalStateException("Request stream is still active")
        }
        if (!job.isActive) {
            endCurrent(interrupted = true, retireSession = false)
            throw CancellationException("Request cancelled")
        }
    }

    fun endCurrent(interrupted: Boolean, retireSession: Boolean) {
        stream.getAndSet(null)?.end(interrupted, retireSession)
    }
}

private object DeviceEndpoint {
    private val lock = Mutex()
    private var instance: Endpoint? = null

    suspend fun get(context: Context): Endpoint = lock.withLock {
        instance ?: Endpoint.bind(EndpointOptions(
            preset = presetN0(),
            secretKey = IrohIdentity.load(context),
            alpns = listOf(ALPN)
        )).also { instance = it }
    }
}

internal class IrohTransport(
    private val context: Context, private val pcID: String
) : Interceptor {
    private val lock = Mutex()
    private val connectLock = Mutex()
    private var session: ConnectionSession? = null
    @Volatile private var closed = false
    private val active = ConcurrentHashMap<Call, ActiveRequest>()
    private val cleanup = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private fun disconnect(connection: Connection) {
        try { connection.close(0L, byteArrayOf()) }
        catch (_: Exception) { /* Already closed. */ }
        try { connection.close() }
        catch (_: Exception) { /* Already released. */ }
    }

    // The mutex guards ownership only. Native close must never run under it.
    // The transition returning a handle is exclusive, so it closes exactly once.
    private fun retireLocked(target: ConnectionSession): Connection? {
        if (!target.cached) return null
        target.cached = false
        if (session === target) session = null
        Log.i("PrismoIroh", "Connection retired")
        return target.handle.takeIf { target.users == 0 }
    }

    private fun retire(target: ConnectionSession) = runBlocking {
        val closing = lock.withLock { retireLocked(target) }
        closing?.let(::disconnect)
    }

    private fun releaseLocked(target: ConnectionSession): Connection? {
        check(target.users > 0) { "Connection session released more than once" }
        target.users--
        return target.handle.takeIf { !target.cached && target.users == 0 }
    }

    private fun release(target: ConnectionSession) = runBlocking {
        val closing = lock.withLock { releaseLocked(target) }
        closing?.let(::disconnect)
    }

    private fun owned(target: ConnectionSession, stream: BiStream): RequestStream =
        RequestStream(stream, target, cleanup, ::retire, ::release)

    fun cancel(call: Call) {
        active[call]?.let { request ->
            request.job.cancel()
            request.endCurrent(interrupted = true, retireSession = false)
            active.remove(call, request)
        }
    }

    fun close() {
        closed = true
        active.keys.toList().forEach { call ->
            cancel(call)
            call.cancel()
        }
        cleanup.launch {
            val closing = lock.withLock { session?.let(::retireLocked) }
            closing?.let(::disconnect)
        }
    }

    private fun finish(call: Call, request: ActiveRequest) {
        active.remove(call, request)
        request.job.cancel()
    }

    private suspend fun acquireSession(): ConnectionSession? = lock.withLock {
        if (closed) throw IOException("연결이 종료되었습니다.")
        session?.also { it.users++ }
    }

    private suspend fun openOn(target: ConnectionSession): RequestStream {
        var bi: BiStream? = null
        try {
            val opened = target.handle.openBi()
            bi = opened
            // A concurrent failure can retire this session while openBi is pending.
            lock.withLock {
                if (closed || !target.cached) throw IOException("연결이 종료되었습니다.")
            }
            return owned(target, opened)
        } catch (error: Exception) {
            try { bi?.close() } catch (_: Exception) {}
            // Only connection-level failures and an unresponsive attempt retire
            // the cache. A stream reset or caller cancellation stays local.
            if (shouldRetireSession(error)) retire(target)
            release(target)
            throw error
        }
    }

    private suspend fun connectFresh(): Connection {
        // EndpointId and EndpointAddr also own UniFFI native handles.
        val peer = EndpointId.fromString(pcID)
        try {
            val address = EndpointAddr(peer, null, emptyList())
            try {
                return DeviceEndpoint.get(context).connect(address, ALPN)
            } finally {
                address.close()
            }
        } finally {
            peer.close()
        }
    }

    private suspend fun open(): RequestStream {
        acquireSession()?.let { return openOn(it) }
        // Only the initial connection handshake is serialized. Other streams
        // on an established connection do not wait behind a slow openBi().
        return connectLock.withLock {
            acquireSession()?.let { return@withLock openOn(it) }
            val fresh = connectFresh()
            var bi: BiStream? = null
            try {
                val opened = fresh.openBi()
                bi = opened
                val created = ConnectionSession(fresh)
                lock.withLock {
                    if (closed) throw IOException("연결이 종료되었습니다.")
                    created.users = 1
                    session = created
                }
                Log.i("PrismoIroh", "Connection established")
                owned(created, opened)
            } catch (error: Exception) {
                try { bi?.close() } catch (_: Exception) {}
                disconnect(fresh)
                throw error
            }
        }
    }

    private fun isTransportFailure(error: Exception): Boolean =
        error is IOException || error is IllegalStateException ||
            error is TimeoutCancellationException || error is IrohException

    private suspend fun receiveHeader(
        call: Call, request: Request, current: ActiveRequest, packet: ByteArray,
        timeout: Long
    ): Pair<RequestStream, JSONObject> = withHeaderRetry(
        method = request.method, timeout = timeout,
        attempt = {
            val opened = open()
            current.attach(opened)
            if (call.isCanceled()) throw CancellationException("Request cancelled")
            val header = opened.use { owner ->
                val prefix = ByteBuffer.allocate(4).putInt(packet.size).array()
                owner.sender.writeAll(prefix)
                owner.sender.writeAll(packet)
                owner.sender.finish()
                val size = ByteBuffer.wrap(owner.receiver.readExact(4u)).int
                require(size in 2..8192) { "Invalid response" }
                JSONObject(String(owner.receiver.readExact(size.toUInt()), StandardCharsets.UTF_8))
            }
            Pair(opened, header)
        },
        onFailure = { error ->
            val cancelled = closed || call.isCanceled() || !current.job.isActive
            val retryable = !cancelled && isTransportFailure(error)
            current.endCurrent(interrupted = true,
                retireSession = retryable && shouldRetireSession(error))
            if (retryable) Log.w("PrismoIroh",
                "Response header failed: " + error.javaClass.simpleName)
            retryable
        }
    )

    override fun intercept(chain: Interceptor.Chain): Response {
        if (closed) throw IOException("연결이 종료되었습니다.")
        val call = chain.call()
        val current = ActiveRequest()
        active[call] = current
        try {
            if (call.isCanceled()) throw IOException("요청이 취소되었습니다.")
            val request = chain.request()
            val bodyBuffer = Buffer()
            request.body?.writeTo(bodyBuffer)
            val body = bodyBuffer.readByteArray()
            require(body.size <= 4096) { "Request too large" }
            val path = request.url.encodedPath +
                (request.url.encodedQuery?.let { "?" + it } ?: "")
            val packet = JSONObject()
                .put("method", request.method)
                .put("path", path)
                .put("body", Base64.encodeToString(body, Base64.NO_WRAP))
                .put("authorization", request.header("Authorization") ?: "")
                .toString().toByteArray(StandardCharsets.UTF_8)
            require(packet.size in 2..8192) { "Request too large" }

            val headerTimeout = when (path) {
                "/api/v1/app/update/download" -> 300_000L
                "/api/v1/pair" -> 100_000L
                else -> 20_000L
            }
            val (bi, header) = runBlocking(current.job) {
                receiveHeader(call, request, current, packet, headerTimeout)
            }
            val code = header.getInt("status")
            val length = header.getLong("length")
            require(code in 100..599 && length in 0..MAX_RESPONSE) { "Invalid response" }
            val type = header.optString("type", "application/octet-stream")
            val responseBody = IrohBody(bi, length, type, current.job) { interrupted, retireSession ->
                current.endCurrent(interrupted, retireSession)
                finish(call, current)
            }
            return Response.Builder().request(request)
                .protocol(Protocol.HTTP_1_1).code(code).message("OK")
                .header("Content-Type", type)
                .header("Content-Length", length.toString())
                .body(responseBody).build()
        } catch (error: Exception) {
            val failed = !closed && !call.isCanceled() && current.job.isActive &&
                shouldRetireSession(error)
            current.endCurrent(interrupted = true, retireSession = failed)
            finish(call, current)
            if (error is CancellationException) {
                throw IOException("연결 요청이 종료되었습니다.", error)
            }
            throw asIrohIOException(error)
        }
    }
}

private class IrohBody(
    private val stream: RequestStream,
    private val length: Long,
    private val type: String,
    private val job: Job,
    private val onClose: (Boolean, Boolean) -> Unit
) : ResponseBody() {
    @Volatile private var remaining = length
    private val closed = AtomicBoolean(false)

    private fun end(retireSession: Boolean, reason: String = "") {
        if (!closed.compareAndSet(false, true)) return
        if (reason.isNotEmpty()) Log.w("PrismoIroh", "Response body failed: " + reason)
        onClose(remaining > 0, retireSession)
    }

    // A complete Content-Length is not the QUIC stream's end-of-stream marker.
    // Consume the peer's FIN before releasing the native BiStream; otherwise
    // closing the receive half can report STOP_SENDING to the Windows host.
    private suspend fun receive(count: Int): ByteArray = stream.use { owner ->
        val payload = if (count == 0) ByteArray(0)
            else withTimeout(40_000) { owner.receiver.readExact(count.toUInt()) }
        if (remaining == count.toLong()) {
            val trailing = withTimeout(40_000) { owner.receiver.read(1u) }
            if (trailing.isNotEmpty()) throw IOException("Unexpected trailing response data")
        }
        payload
    }

    private val incoming: BufferedSource = object : Source {
        override fun read(sink: Buffer, byteCount: Long): Long {
            if (byteCount == 0L) return 0L
            if (remaining == 0L) return -1L
            val count = min(min(remaining, byteCount), 65536L).toInt()
            val bytes = try {
                runBlocking(job) { receive(count) }
            } catch (error: Exception) {
                end(job.isActive && shouldRetireSession(error), error.javaClass.simpleName)
                if (error is CancellationException) {
                    throw IOException("데이터를 받지 못했습니다.", error)
                }
                throw asIrohIOException(error)
            }
            if (bytes.size != count) {
                end(retireSession = false, reason = "IncompleteResponse")
                throw IOException("Incomplete response")
            }
            sink.write(bytes)
            remaining -= bytes.size
            if (remaining == 0L) end(retireSession = false)
            return bytes.size.toLong()
        }

        override fun timeout(): Timeout = Timeout.NONE
        override fun close() { end(retireSession = false) }
    }.buffer()

    init {
        if (length == 0L) {
            // Retrofit may never call read() for an empty body.
            runBlocking(job) { receive(0) }
            end(retireSession = false)
        }
    }

    override fun contentLength(): Long = length
    override fun contentType() = type.toMediaTypeOrNull()
    override fun source(): BufferedSource = incoming
}
