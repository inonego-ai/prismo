package dev.prismo.app

import java.io.IOException
import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class IrohIOExceptionTest {
    @Test
    fun destroyedNativeStreamBecomesNetworkFailure() {
        val cause = IllegalStateException("BiStream object has already been destroyed")

        val result = asIrohIOException(cause)

        assertEquals("Iroh 통신 중 오류가 발생했습니다.", result.message)
        assertSame(cause, result.cause)
    }

    @Test
    fun existingNetworkFailureKeepsItsIdentity() {
        val cause = IOException("Connection closed")

        assertSame(cause, asIrohIOException(cause))
    }

    @Test
    fun cancellationKeepsItsCauseWhenConverted() {
        val cause = CancellationException("Request canceled")

        assertSame(cause, asIrohIOException(cause).cause)
    }
}
