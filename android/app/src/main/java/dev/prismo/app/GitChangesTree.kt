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
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private class ChangeFolder(val name: String, val path: String) {
    val folders = linkedMapOf<String, ChangeFolder>()
    val files = mutableListOf<Change>()
    var count = 0
}

private data class ChangeLine(
    val path: String, val name: String, val depth: Int,
    val directory: Boolean, val count: Int = 0, val change: Change? = null
)

private fun changeLines(changes: List<Change>, collapsed: Set<String>): List<ChangeLine> {
    val root = ChangeFolder("", "")
    for (change in changes) {
        val parts = change.path.split("/")
        var folder = root
        for (part in parts.dropLast(1)) {
            val path = if (folder.path.isEmpty()) part else folder.path + "/" + part
            folder = folder.folders.getOrPut(part) { ChangeFolder(part, path) }
            folder.count++
        }
        folder.files += change
    }
    val rows = mutableListOf<ChangeLine>()
    fun visit(folder: ChangeFolder, depth: Int) {
        for (child in folder.folders.values.sortedBy { it.name.lowercase() }) {
            var last = child
            val names = mutableListOf(child.name)
            while (last.files.isEmpty() && last.folders.size == 1) {
                last = last.folders.values.single()
                names += last.name
            }
            rows += ChangeLine(last.path, compactFolderLabel(names), depth, true, last.count)
            if (last.path !in collapsed) visit(last, depth + 1)
        }
        for (change in folder.files.sortedBy { it.path.lowercase() }) {
            rows += ChangeLine(change.path, change.path.substringAfterLast("/"), depth, false,
                change = change)
        }
    }
    visit(root, 0)
    return rows
}

private fun changeLabel(change: Change, section: String): Pair<String, Color> {
    val kind = if (section == "staged") change.stagedKind else change.workingKind
    return when (kind) {
        "conflicted" -> "충돌" to Color(0xFFEF5350)
        "untracked" -> "미추적" to Color(0xFF4DB6AC)
        "added" -> "추가" to Color(0xFF66BB6A)
        "deleted" -> "삭제" to Color(0xFFEF5350)
        "renamed" -> "이름 변경" to Color(0xFFBA94F2)
        "copied" -> "복사" to Color(0xFFBA94F2)
        else -> "수정" to Color(0xFFFFBE62)
    }
}

@Composable
private fun ChangeTreeRow(
    line: ChangeLine,
    section: String,
    collapsed: Set<String>,
    onToggle: (String) -> Unit,
    open: (String, String?) -> Unit
) {
    val start = treeIndent(line.depth)
    val rowKey = section + ":" + line.path
    val expanding = line.directory && rowKey !in collapsed
    Row(
        Modifier.fillMaxWidth()
            .clickable {
                if (line.directory) onToggle(rowKey)
                else {
                    val change = requireNotNull(line.change)
                    val scope = when {
                        section == "staged" -> "staged"
                        change.workingKind == "untracked" -> "untracked"
                        change.workingKind == "conflicted" -> null
                        else -> "unstaged"
                    }
                    open(change.path, scope)
                }
            }
            .padding(start = start, end = 8.dp)
            .heightIn(min = 38.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (line.directory) {
            Icon(if (expanding) Icons.Outlined.ExpandMore else Icons.Outlined.ChevronRight,
                contentDescription = null,
                modifier = Modifier.size(15.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Icon(if (expanding) Icons.Outlined.FolderOpen else Icons.Outlined.Folder,
                contentDescription = null, modifier = Modifier.size(17.dp),
                tint = Color(0xFFD3A85F))
            Spacer(Modifier.width(7.dp))
            Text(line.name, modifier = Modifier.weight(1f), maxLines = 1,
                overflow = TextOverflow.Ellipsis, fontSize = 13.sp,
                fontWeight = FontWeight.Medium)
            Text(line.count.toString(), fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            Spacer(Modifier.width(15.dp))
            Icon(gitFileIcon(line.name), contentDescription = null,
                modifier = Modifier.size(17.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(7.dp))
            Column(Modifier.weight(1f)) {
                Text(line.name, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    fontSize = 13.sp, lineHeight = 16.sp)
                if (!line.directory && line.depth == 0 && line.path.contains("/")) {
                    Text(line.path.substringBeforeLast("/"), maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontSize = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            val (label, color) = changeLabel(requireNotNull(line.change), section)
            Text(label, fontSize = 10.sp, color = color,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.padding(start = 6.dp))
        }
    }
}

@Composable
internal fun GitChangesTree(
    status: RepoStatus,
    scroll: LazyListState,
    collapsed: List<String>,
    onToggle: (String) -> Unit,
    open: (String, String?) -> Unit
) {
    val staged = status.changes.filter { it.stagedKind != null }
    val working = status.changes.filter { it.workingKind != null }
    val collapsedSet = collapsed.toSet()
    val stagedRows = changeLines(staged, collapsedSet.filter { it.startsWith("staged:") }
        .map { it.removePrefix("staged:") }.toSet())
    val workingRows = changeLines(working, collapsedSet.filter { it.startsWith("working:") }
        .map { it.removePrefix("working:") }.toSet())
    LazyColumn(state = scroll, contentPadding = PaddingValues(bottom = 20.dp)) {
        item(key = "summary") {
            Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
                Text(status.branch, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                Text("변경 파일 " + status.changes.size + "개", fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        item(key = "staged-title") {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text("스테이징됨", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(8.dp))
                Text(staged.size.toString(), fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (stagedRows.isEmpty()) item(key = "staged-empty") {
            Text("스테이징된 변경사항 없음", fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        }
        items(stagedRows, key = { "staged:" + it.path }) { line ->
            ChangeTreeRow(line, "staged", collapsedSet, onToggle, open)
        }
        item(key = "working-title") {
            HorizontalDivider()
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Text("작업 중", fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(8.dp))
                Text(working.size.toString(), fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                Text("미추적 포함", fontSize = 10.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (workingRows.isEmpty()) item(key = "working-empty") {
            Text("작업 중인 변경사항 없음", fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        }
        items(workingRows, key = { "working:" + it.path }) { line ->
            ChangeTreeRow(line, "working", collapsedSet, onToggle, open)
        }
    }
}
