package dev.prismo.app

import org.junit.Assert.assertEquals
import org.junit.Test

class PageMergeTest {
    @Test
    fun firstPageReplacesPreviouslyLoadedItems() {
        assertEquals(
            listOf("fresh-a", "fresh-b"),
            mergePage(listOf("stale-a", "stale-b"), listOf("fresh-a", "fresh-b"), true)
        )
    }

    @Test
    fun nextPageKeepsExistingItemsAndAppendsNewItems() {
        assertEquals(
            listOf("first", "second"),
            mergePage(listOf("first"), listOf("second"), false)
        )
    }

    @Test
    fun emptyNextPageDoesNotDiscardExistingItems() {
        assertEquals(listOf("existing"), mergePage(listOf("existing"), emptyList(), false))
    }

    @Test
    fun refreshRequestsTheFirstPageWithoutChangingTheStoredCursor() {
        assertEquals(null, requestPageCursor(refresh = 2, loadedRefresh = 1, cursor = "page-4"))
    }

    @Test
    fun paginationKeepsTheCurrentCursorUntilRefreshChanges() {
        assertEquals("page-4", requestPageCursor(refresh = 2, loadedRefresh = 2, cursor = "page-4"))
    }
}
