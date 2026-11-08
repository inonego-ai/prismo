package dev.prismo.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import computer.iroh.Endpoint
import computer.iroh.EndpointOptions
import computer.iroh.presetN0
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs the actual Android x86_64/ARM64 native Iroh bindings, not desktop JNI.
 * Tests the QUIC stream lifecycle independently of Retrofit and Compose.
 */
@RunWith(AndroidJUnit4::class)
class IrohAndroidNativeTest {
    @Test fun repeatedNativeRequestsCompleteWithFin() = runBlocking {
        val alpn = "prismo/git/1".toByteArray(Charsets.UTF_8)
        val listener = Endpoint.bind(EndpointOptions(preset = presetN0(), alpns = listOf(alpn)))
        try {
            val client = Endpoint.bind(EndpointOptions(preset = presetN0(), alpns = listOf(alpn)))
            try {
                withTimeout(45_000) {
                    val server = async(Dispatchers.IO) {
                        val incoming = requireNotNull(listener.acceptNext())
                        val connection = incoming.accept().connect()
                        try {
                            repeat(12) {
                                val bi = connection.acceptBi()
                                val recv = bi.recv()
                                val send = bi.send()
                                try {
                                    assertArrayEquals(byteArrayOf(1, 2, 3), recv.readExact(3u))
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
                    val address = listener.addr()
                    val connection = try { client.connect(address, alpn) }
                        finally { address.close() }
                    try {
                        repeat(12) {
                            val bi = connection.openBi()
                            val recv = bi.recv()
                            val send = bi.send()
                            try {
                                send.writeAll(byteArrayOf(1, 2, 3))
                                send.finish()
                                assertArrayEquals(byteArrayOf(4, 5, 6), recv.readExact(3u))
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
                    server.await()
                }
            } finally {
                try { client.shutdown() } finally { client.close() }
            }
        } finally {
            try { listener.shutdown() } finally { listener.close() }
        }
    }
}
