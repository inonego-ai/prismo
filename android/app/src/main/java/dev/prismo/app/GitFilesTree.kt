package dev.prismo.app

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import retrofit2.HttpException

internal sealed interface FileTreeRow {
    val level: Int
    val key: String

    data class Entry(
        val item: TreeEntry, val label: String, override val level: Int
    ) : FileTreeRow {
        override val key get() = "entry:" + item.path
    }

    data class Loading(val folder: String, override val level: Int) : FileTreeRow {
        override val key get() = "loading:" + folder
    }

    data class LoadMore(val folder: String, override val level: Int) : FileTreeRow {
        override val key get() = "more:" + folder
    }
}

internal fun fileRows(
    pages: Map<String, List<TreeEntry>>,
    cursors: Map<String, String?>,
    expanded: Set<String>
): List<FileTreeRow> {
    val output = mutableListOf<FileTreeRow>()
    fun visit(folder: String, level: Int) {
        for (entry in pages[folder].orEmpty()) {
            var deepest = entry
            val names = mutableListOf(entry.name)
            if (entry.directory) {
                while (deepest.path in expanded) {
                    val children = pages[deepest.path] ?: break
                    if (cursors[deepest.path] != null || children.size != 1) break
                    val next = children.single()
                    if (!next.directory || next.path !in expanded
                        || !pages.containsKey(next.path)) break
                    deepest = next
                    names += next.name
                }
            }
            output += FileTreeRow.Entry(
                entry, if (entry.directory) compactFolderLabel(names) else entry.name, level
            )
            if (entry.directory && entry.path in expanded) {
                if (pages.containsKey(deepest.path)) visit(deepest.path, level + 1)
                else output += FileTreeRow.Loading(deepest.path, level + 1)
            }
        }
        if (cursors[folder] != null) output += FileTreeRow.LoadMore(folder, level)
    }
    visit("", 0)
    return output
}

@Composable
internal fun GitFilesTree(
    api: PrismoAPI,
    id: String,
    refresh: Int,
    scroll: LazyListState,
    expanded: List<String>,
    onToggle: (String) -> Unit,
    open: (String) -> Unit
) {
    val pages = remember(id, refresh) { mutableStateMapOf<String, List<TreeEntry>>() }
    val cursors = remember(id, refresh) { mutableStateMapOf<String, String?>() }
    val loadingFolders = remember(id, refresh) { mutableStateMapOf<String, Boolean>() }
    val failedFolders = remember(id, refresh) { mutableStateMapOf<String, Boolean>() }
    val scope = rememberCoroutineScope()
    val concurrency = remember(id, refresh) { Semaphore(4) }
    var retry by remember(id, refresh) { mutableIntStateOf(0) }
    var error by remember(id, refresh) { mutableStateOf<String?>(null) }

    fun loadFolder(folder: String, more: Boolean = false) {
        if (loadingFolders.containsKey(folder) || (!more && pages.containsKey(folder))) return
        if (more && cursors[folder] == null) return
        loadingFolders[folder] = true
        scope.launch {
            try {
                concurrency.withPermit {
                    val cursor = if (more) cursors[folder] else null
                    var expired = false
                    val page = try {
                        api.tree(id, folder, cursor)
                    } catch (exception: HttpException) {
                        if (exception.code() != 410 || cursor == null) throw exception
                        expired = true
                        api.tree(id, folder)
                    }
                    pages[folder] = if (cursor != null && !expired) {
                        pages[folder].orEmpty() + page.entries
                    } else page.entries
                    cursors[folder] = page.nextCursor
                }
                failedFolders.remove(folder)
                error = if (failedFolders.isNotEmpty()) "일부 폴더를 불러오지 못했습니다." else null
            } catch (exception: CancellationException) {
                throw exception
            } catch (_: Exception) {
                failedFolders[folder] = true
                error = "일부 폴더를 불러오지 못했습니다."
            } finally {
                loadingFolders.remove(folder)
            }
        }
    }

    val expandedSet = expanded.toSet()
    val rows = fileRows(pages, cursors, expandedSet)
    val visibleFolders = rows.filterIsInstance<FileTreeRow.Entry>()
        .filter { it.item.directory && it.item.path in expandedSet }
        .map { it.item.path }

    LaunchedEffect(api, id, refresh, visibleFolders, retry) {
        loadFolder("")
        for (folder in visibleFolders) loadFolder(folder)
    }
    Column(Modifier.fillMaxSize()) {
        Text("파일 탐색기", style = MaterialTheme.typography.titleMedium,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp))
        if (error != null) {
            Text(error.orEmpty(), modifier = Modifier.padding(horizontal = 12.dp),
                color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
            TextButton(onClick = { retry++ }) { Text("다시 시도") }
        }
        if (loadingFolders.isNotEmpty()) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn(state = scroll, contentPadding = PaddingValues(bottom = 20.dp)) {
            items(rows, key = { it.key }) { row ->
                val entry = (row as? FileTreeRow.Entry)?.item
                val isFolder = entry?.directory == true
                val name = when (row) {
                    is FileTreeRow.Entry -> row.label
                    is FileTreeRow.Loading ->
                        if (failedFolders.containsKey(row.folder)) "불러오기 실패 · 다시 시도"
                        else "읽는 중…"
                    is FileTreeRow.LoadMore -> "더 보기"
                }
                Row(Modifier.fillMaxWidth()
                    .clickable(enabled = (row !is FileTreeRow.Loading
                        || failedFolders.containsKey(row.folder))
                        && !(row is FileTreeRow.LoadMore && loadingFolders.containsKey(row.folder))) {
                        when (row) {
                            is FileTreeRow.Entry ->
                                if (row.item.directory) onToggle(row.item.path)
                                else open(row.item.path)
                            is FileTreeRow.LoadMore -> loadFolder(row.folder, more = true)
                            is FileTreeRow.Loading -> {
                                if (failedFolders.containsKey(row.folder)) {
                                    failedFolders.remove(row.folder)
                                    loadFolder(row.folder)
                                }
                            }
                        }
                    }
                    .padding(start = treeIndent(row.level), end = 12.dp)
                    .heightIn(min = 38.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    if (isFolder) {
                        val expandedFolder = requireNotNull(entry).path in expandedSet
                        Icon(if (expandedFolder) Icons.Outlined.ExpandMore
                            else Icons.Outlined.ChevronRight,
                            contentDescription = null, modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Icon(if (expandedFolder) Icons.Outlined.FolderOpen
                            else Icons.Outlined.Folder,
                            contentDescription = null, modifier = Modifier.size(18.dp),
                            tint = Color(0xFFD3A85F))
                    } else {
                        Spacer(Modifier.width(16.dp))
                        if (entry != null) {
                            Icon(gitFileIcon(entry.name), contentDescription = null,
                                modifier = Modifier.size(18.dp),
                                tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else Spacer(Modifier.width(18.dp))
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(name, modifier = Modifier.weight(1f), maxLines = 1,
                        overflow = TextOverflow.Ellipsis, fontSize = 13.sp,
                        fontWeight = if (isFolder) FontWeight.Medium else FontWeight.Normal,
                        color = if (row is FileTreeRow.LoadMore) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.onSurface)
                }
            }
            if (rows.isEmpty() && loadingFolders.isEmpty() && error == null) item {
                Text("파일이 없습니다.", modifier = Modifier.padding(16.dp),
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
