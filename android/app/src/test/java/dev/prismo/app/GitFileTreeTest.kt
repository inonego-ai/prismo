package dev.prismo.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GitFileTreeTest {
    @Test
    fun expandedFolderKeepsRealPathsAndPaginationControlsSeparate() {
        val rows = fileRows(
            pages = mapOf(
                "" to listOf(TreeEntry("src", "src", true)),
                "src" to listOf(TreeEntry("main.kt", "src/main.kt", false))
            ),
            cursors = mapOf("src" to "next-page"),
            expanded = setOf("src")
        )
        assertEquals(listOf("entry:src", "entry:src/main.kt", "more:src"),
            rows.map { it.key })
        assertTrue(rows.last() is FileTreeRow.LoadMore)
        assertEquals("src/main.kt", (rows[1] as FileTreeRow.Entry).item.path)
    }

    @Test
    fun pendingFolderUsesLoadingRowWithoutInventingGitPaths() {
        val rows = fileRows(
            pages = mapOf("" to listOf(TreeEntry("src", "src", true))),
            cursors = emptyMap(),
            expanded = setOf("src")
        )
        assertEquals(listOf("entry:src", "loading:src"), rows.map { it.key })
        assertTrue(rows.last() is FileTreeRow.Loading)
    }

    @Test
    fun expandedSingleChildFolderChainIsCompactedWithoutChangingFilePath() {
        val rows = fileRows(
            pages = mapOf(
                "" to listOf(TreeEntry("src", "src", true)),
                "src" to listOf(TreeEntry("runtime", "src/runtime", true)),
                "src/runtime" to listOf(TreeEntry("readme.md", "src/runtime/readme.md", false))
            ),
            cursors = emptyMap(),
            expanded = setOf("src", "src/runtime")
        )
        assertEquals(listOf("entry:src", "entry:src/runtime/readme.md"),
            rows.map { it.key })
        assertEquals("src / runtime", (rows.first() as FileTreeRow.Entry).label)
    }
}
