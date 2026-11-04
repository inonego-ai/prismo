package dev.prismo.app

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Image
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

internal fun compactFolderLabel(parts: List<String>): String =
    if (parts.size <= 3) parts.joinToString(" / ")
    else parts.first() + " / … / " + parts.takeLast(2).joinToString(" / ")

internal fun treeIndent(depth: Int) = (depth.coerceAtMost(8) * 11).dp

internal fun gitFileIcon(name: String): ImageVector {
    val suffix = name.substringAfterLast(".", "").lowercase()
    return when (suffix) {
        "cs", "kt", "kts", "java", "js", "jsx", "ts", "tsx", "py", "rs",
        "go", "cpp", "c", "h", "hpp", "html", "css", "xml", "json", "yaml",
        "yml", "gradle", "shader", "hlsl" -> Icons.Outlined.Code
        "png", "jpg", "jpeg", "webp", "gif", "svg", "tga", "psd" -> Icons.Outlined.Image
        "md", "txt", "log", "pdf", "rst" -> Icons.Outlined.Description
        else -> Icons.AutoMirrored.Outlined.InsertDriveFile
    }
}
