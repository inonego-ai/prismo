package dev.prismo.app

import com.google.gson.JsonParser
import computer.iroh.Endpoint
import computer.iroh.EndpointAddr
import computer.iroh.EndpointId
import computer.iroh.EndpointOptions
import computer.iroh.presetN0
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.nio.ByteBuffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Opt-in Windows/JVM smoke test for UniFFI stream-half ownership. */
class IrohNativeInteropTest {
    @Test fun kotlinClientCanReuseAConnectionToTheWindowsNodeServer() = runBlocking {
        val hostID = System.getenv("PRISMO_NODE_HOST_ID")
        val hostPort = System.getenv("PRISMO_NODE_HOST_PORT")
        assumeTrue(!hostID.isNullOrEmpty() && !hostPort.isNullOrEmpty())
        val alpn = "prismo/git/1".toByteArray(Charsets.UTF_8)
        val endpoint = Endpoint.bind(EndpointOptions(preset = presetN0(), alpns = listOf(alpn)))
        val address = EndpointAddr(EndpointId.fromString(requireNotNull(hostID)),
            null, listOf("127.0.0.1:" + requireNotNull(hostPort)))
        try {
            withTimeout(30_000) {
                val connection = endpoint.connect(address, alpn)
                try {
                    val request = """{"method":"GET","path":"/health","body":"","authorization":""}"""
                        .toByteArray(Charsets.UTF_8)
                    val prefix = ByteBuffer.allocate(4).putInt(request.size).array()
                    repeat(16) {
                        val bi = connection.openBi()
                        val recv = bi.recv()
                        val send = bi.send()
                        try {
                            send.writeAll(prefix)
                            send.writeAll(request)
                            send.finish()
                            val size = ByteBuffer.wrap(recv.readExact(4u)).int
                            val header = JsonParser.parseString(
                                String(recv.readExact(size.toUInt()), Charsets.UTF_8)).asJsonObject
                            assertEquals(200, header.get("status").asInt)
                            val body = recv.readExact(header.get("length").asInt.toUInt())
                            assertTrue(String(body, Charsets.UTF_8).contains("Prismo"))
                            assertTrue(recv.read(1u).isEmpty())
                        } finally {
                            recv.close()
                            send.close()
                            bi.close()
                        }
                    }
                } finally {
                    connection.close(0L, byteArrayOf())
                    connection.close()
                }
            }
        } finally {
            address.close()
            try { endpoint.shutdown() } finally { endpoint.close() }
        }
    }

    @Test fun repeatedRequestsUseTheSameSendAndReceiveHandlesUntilFin() = runBlocking {
        assumeTrue(System.getenv("PRISMO_NATIVE_IROH_SMOKE") == "1")
        val alpn = "prismo/git/1".toByteArray(Charsets.UTF_8)
        val listener = Endpoint.bind(EndpointOptions(preset = presetN0(), alpns = listOf(alpn)))
        val caller = Endpoint.bind(EndpointOptions(preset = presetN0(), alpns = listOf(alpn)))
        try {
            withTimeout(30_000) {
                val remote = async(Dispatchers.IO) {
                    val incoming = requireNotNull(listener.acceptNext())
                    val connection = incoming.accept().connect()
                    try {
                        repeat(16) {
                            val bi = connection.acceptBi()
                            val recv = bi.recv()
                            val send = bi.send()
                            try {
                                assertArrayEquals(byteArrayOf(1, 2, 3),
                                    recv.readExact(3u))
                                send.writeAll(byteArrayOf(4, 5, 6))
                                send.finish()
                            } finally {
                                recv.close()
                                send.close()
                                bi.close()
                            }
                        }
                    } finally {
                        connection.close(0L, byteArrayOf())
                        connection.close()
                    }
                }
                val connection = caller.connect(listener.addr(), alpn)
                try {
                    repeat(16) {
                        val bi = connection.openBi()
                        val recv = bi.recv()
                        val send = bi.send()
                        try {
                            send.writeAll(byteArrayOf(1, 2, 3))
                            send.finish()
                            assertArrayEquals(byteArrayOf(4, 5, 6),
                                recv.readExact(3u))
                            assertTrue(recv.read(1u).isEmpty())
                        } finally {
                            recv.close()
                            send.close()
                            bi.close()
                        }
                    }
                } finally {
                    connection.close(0L, byteArrayOf())
                    connection.close()
                }
                remote.await()
            }
        } finally {
            try { caller.shutdown() } finally { caller.close() }
            try { listener.shutdown() } finally { listener.close() }
        }
    }
}
