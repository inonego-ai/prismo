package dev.prismo.app

import com.google.gson.Gson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CommitFilesTest {
    private val gson = Gson()

    @Test
    fun commitFileMetadataIncludesDeletionStatuses() {
        val data = gson.fromJson(
            """{"files":["removed.png","retained.png"],"deletedFiles":["removed.png"]}""",
            CommitFiles::class.java
        )
        assertEquals(listOf("removed.png", "retained.png"), data.files)
        assertTrue("removed.png" in data.deletedFiles)
        assertFalse("retained.png" in data.deletedFiles)
    }
}
