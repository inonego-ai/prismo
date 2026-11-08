package dev.prismo.app

import org.junit.Assert.assertEquals
import org.junit.Test

class IrohIdentityContractTest {
    @Test
    fun tokensMustUseEncryptedStorageFormat() {
        assertEquals("", IrohIdentity.revealToken("a".repeat(43)))
        assertEquals("", IrohIdentity.revealToken("not-encrypted"))
        assertEquals("", IrohIdentity.revealToken(""))
    }
}
