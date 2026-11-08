package dev.prismo.app

import computer.iroh.IrohErrorKind
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class IrohHeaderRetryTest {
    @Test fun streamFailuresDoNotRetireTheSharedConnection() {
        for (kind in listOf(IrohErrorKind.STREAM, IrohErrorKind.INVALID_INPUT,
            IrohErrorKind.INTERNAL, IrohErrorKind.DATAGRAM)) {
            assertEquals("Only a request may fail on " + kind, false,
                isConnectionError(kind))
        }
        for (kind in listOf(IrohErrorKind.CONNECTION, IrohErrorKind.CONNECT,
            IrohErrorKind.CLOSED, IrohErrorKind.RELAY, IrohErrorKind.TIMEOUT)) {
            assertEquals("Connection must be replaced on " + kind, true,
                isConnectionError(kind))
        }
    }

    @Test fun stalledAttemptsRetireTheSessionButRequestCancellationDoesNot() = runBlocking {
        var timeoutObserved = false
        try {
            withTimeout(20) { delay(100) }
            fail("Expected a stalled Iroh attempt to time out")
        } catch (error: TimeoutCancellationException) {
            timeoutObserved = true
            assertEquals(true, shouldRetireSession(error))
        }
        assertEquals(true, timeoutObserved)
        assertEquals(false, shouldRetireSession(CancellationException("Screen closed")))
        assertEquals(false, shouldRetireSession(IOException("Request stream reset")))
        assertEquals(false, shouldRetireSession(IllegalStateException("Invalid response")))
    }

    @Test fun getRetriesAfterTheExpiredAttemptScopeHasEnded() = runBlocking {
        var attempts = 0
        var failures = 0
        val result = withHeaderRetry("GET", 30,
            attempt = {
                attempts++
                if (attempts == 1) delay(100)
                "connected"
            },
            onFailure = {
                failures++
                it is TimeoutCancellationException
            })
        assertEquals("connected", result)
        assertEquals(2, attempts)
        assertEquals(1, failures)
    }

    @Test fun postIsNeverReplayedAfterTimeout() = runBlocking {
        var attempts = 0
        try {
            withHeaderRetry("POST", 30,
                attempt = {
                    attempts++
                    delay(100)
                    "unexpected"
                },
                onFailure = { true })
            fail("The timed-out POST must fail")
        } catch (_: TimeoutCancellationException) {
            assertEquals(1, attempts)
        }
    }

    @Test fun callerCancellationIsNotRetried() = runBlocking {
        val cancelled = CancellationException("Caller left")
        var attempts = 0
        try {
            withHeaderRetry("GET", 100,
                attempt = { attempts++; throw cancelled },
                onFailure = { false })
            fail("Cancelled work must not be retried")
        } catch (error: CancellationException) {
            assertEquals(cancelled.message, error.message)
            assertEquals(1, attempts)
        }
    }
}
