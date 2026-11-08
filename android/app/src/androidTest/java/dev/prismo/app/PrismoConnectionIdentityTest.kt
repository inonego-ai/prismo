package dev.prismo.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PrismoConnectionIdentityTest {
    @Test fun connectionIsAReflexiveAndStableAPIKey() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val first = PrismoClient.create(context, "0".repeat(64))
        val second = PrismoClient.create(context, "0".repeat(64))
        try {
            val api: PrismoAPI = first
            assertTrue(api === first)
            assertTrue(api == api)
            assertTrue(first == first)
            assertFalse(first == second)
        } finally {
            first.close()
            second.close()
        }
    }
}
