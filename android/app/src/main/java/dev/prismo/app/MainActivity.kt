package dev.prismo.app

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Difference
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.History
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.map
import java.net.URI
import retrofit2.HttpException
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { PrismoApp() }
    }
}
private val darkScheme = darkColorScheme(
    primary = Color(0xFFEAEAEA), onPrimary = Color(0xFF141414),
    background = Color(0xFF090909), onBackground = Color(0xFFEAEAEA),
    surface = Color(0xFF111111), onSurface = Color(0xFFE8E8E8),
    surfaceVariant = Color(0xFF202020), onSurfaceVariant = Color(0xFFA3A3A3),
    outline = Color(0xFF393939), outlineVariant = Color(0xFF282828),
    secondaryContainer = Color(0xFF292929), onSecondaryContainer = Color(0xFFEAEAEA)
)
private data class ReaderTarget(
    val path: String, val scope: String? = null, val commit: String? = null
)
private sealed interface UpdateState {
    data object Checking : UpdateState
    data object Unconfigured : UpdateState
    data object NotPublished : UpdateState
    data object Current : UpdateState
    data object Failed : UpdateState
    data class Available(val info: AppUpdate) : UpdateState
    data class PermissionRequired(val info: AppUpdate) : UpdateState
    data object Downloading : UpdateState
    data object InstallPending : UpdateState
}
private sealed interface ReaderResult {
    data object Loading : ReaderResult
    data class Content(val text: String) : ReaderResult
    data object Missing : ReaderResult
    data object Failed : ReaderResult
}
internal fun <T> mergePage(existing: List<T>, incoming: List<T>, firstPage: Boolean): List<T> =
    if (firstPage) incoming else existing + incoming
internal fun requestPageCursor(refresh: Int, loadedRefresh: Int, cursor: String?): String? =
    if (refresh != loadedRefresh) null else cursor

private enum class Tab(val title: String, val icon: ImageVector) {
    Changes("변경", Icons.Outlined.Difference),
    Files("파일", Icons.Outlined.FolderOpen),
    History("기록", Icons.Outlined.History)
}
@Composable
private fun PrismoApp() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val flow = remember(context) { context.viewerPreferences.map { it as ViewerPreferences? } }
    val observedPreferences by flow.collectAsState(initial = null)
    val prefs = observedPreferences
    MaterialTheme(colorScheme = if (prefs?.dark != false) darkScheme else lightColorScheme()) {
        Surface(modifier = Modifier.fillMaxSize()) {
            if (prefs == null) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            } else if (prefs.pcURL.isBlank() || prefs.deviceToken.isBlank()) {
                PairingScreen { url, token ->
                    scope.launch { context.updateViewerPreferences { it.copy(pcURL = url, deviceToken = token) } }
                }
            } else {
                val api = remember(prefs.pcURL, prefs.deviceToken) {
                    PrismoClient.create(prefs.pcURL, prefs.deviceToken)
                }
                key(prefs.pcURL, prefs.deviceToken) {
                    RepositoryHome(
                        api = api, prefs = prefs,
                        onPrefs = { change ->
                            scope.launch { context.updateViewerPreferences(change) }
                        }
                    )
                }
            }
        }
    }
}
private data class PairCode(val address: String, val secret: String)
private fun parsePairCode(input: String): PairCode {
    val uri = URI(input.trim())
    require(uri.scheme == "https" && uri.host?.endsWith(".ts.net", ignoreCase = true) == true
        && uri.port == -1 && uri.userInfo == null && uri.rawQuery == null
        && (uri.path.isNullOrBlank() || uri.path == "/")) {
        "올바른 QR 코드가 아닙니다."
    }
    val fragment = uri.rawFragment.orEmpty()
    require(fragment.startsWith("pair=")) { "올바른 QR 코드가 아닙니다." }
    val secret = fragment.removePrefix("pair=")
    require(Regex("[A-Za-z0-9_-]{43}").matches(secret)) { "올바른 QR 코드가 아닙니다." }
    return PairCode(uri.scheme + "://" + uri.authority, secret)
}
@Composable
private fun PairingScreen(onConnected: (String, String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var input by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var showManual by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun connect(raw: String) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try {
                val pairing = parsePairCode(raw)
                val api = PrismoClient.create(pairing.address)
                require(api.health().service == "Prismo") { "연결할 수 없습니다." }
                val response = api.pair(PairRequest(pairing.secret))
                onConnected(pairing.address, response.token)
            } catch (exception: CancellationException) {
                throw exception
            } catch (exception: Exception) {
                error = "연결할 수 없습니다."
            } finally { busy = false }
        }
    }
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text("Prismo", style = MaterialTheme.typography.headlineLarge,
            fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(28.dp))
        Button(
            onClick = {
                GmsBarcodeScanning.getClient(context).startScan()
                    .addOnSuccessListener { barcode ->
                        barcode.rawValue?.let { connect(it) }
                    }.addOnFailureListener { error = "QR 코드를 읽을 수 없습니다." }
            }, enabled = !busy, modifier = Modifier.fillMaxWidth()
        ) {
            Icon(Icons.Outlined.QrCodeScanner, contentDescription = null)
            Spacer(Modifier.width(8.dp))
            Text(if (busy) "연결 중..." else "QR 코드 스캔")
        }
        TextButton(onClick = { showManual = !showManual }, modifier = Modifier.fillMaxWidth()) {
            Text(if (showManual) "닫기" else "연결 링크 입력")
        }
        if (showManual) {
            OutlinedTextField(
                value = input, onValueChange = { input = it },
                label = { Text("PC 연결 링크") }, singleLine = true,
                modifier = Modifier.fillMaxWidth()
            )
            Button(onClick = { connect(input) }, enabled = !busy && input.isNotBlank(),
                modifier = Modifier.fillMaxWidth()) { Text("연결") }
        }
        ErrorText(error)
    }
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RepositoryHome(api: PrismoAPI, prefs: ViewerPreferences,
                           onPrefs: ((ViewerPreferences) -> ViewerPreferences) -> Unit) {
    var repos by remember { mutableStateOf<List<RepoSummary>>(emptyList()) }
    var initialLoad by remember { mutableStateOf(true) }
    var selectedID by remember { mutableStateOf<String?>(null) }
    var folder by remember(selectedID) { mutableStateOf("") }
    var tab by remember { mutableStateOf(Tab.Changes) }
    var showingSettings by remember { mutableStateOf(false) }
    var target by remember { mutableStateOf<ReaderTarget?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(api, refresh) {
        try {
            val loaded = api.repositories().repositories
            repos = loaded
            if (selectedID != null && loaded.none { it.id == selectedID }) {
                selectedID = null
                target = null
            }
            error = null
        } catch (e: CancellationException) { throw e }
        catch (e: HttpException) {
            if (e.code() == 401) {
                repos = emptyList()
                selectedID = null
                target = null
                onPrefs { it.copy(pcURL = "", deviceToken = "") }
            } else error = "저장소를 불러올 수 없습니다."
        } catch (_: Exception) {
            error = "PC에 연결할 수 없습니다."
        } finally { initialLoad = false }
    }
    val activeTarget = target
    val activeRepo = repos.find { it.id == selectedID }
    BackHandler(enabled = activeTarget != null || showingSettings || activeRepo != null) {
        when {
            activeTarget != null -> target = null
            showingSettings -> showingSettings = false
            activeRepo != null -> { selectedID = null; target = null }
        }
    }
    if (initialLoad) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    if (activeRepo != null && activeTarget != null) {
        ReaderPage(api, activeRepo.id, activeTarget, prefs, onBack = { target = null })
        return
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(when {
                    showingSettings -> "설정"
                    activeRepo == null -> "Prismo"
                    else -> activeRepo.name
                }) },
                navigationIcon = {
                    if (showingSettings) TextButton(onClick = { showingSettings = false }) {
                        Text("‹")
                    } else if (activeRepo != null) TextButton(onClick = { selectedID = null; target = null }) {
                        Text("‹ PC")
                    }
                },
                actions = {
                    if (!showingSettings) {
                        TextButton(onClick = { refresh++ }) { Text("새로고침") }
                        IconButton(onClick = { showingSettings = true }) {
                            Icon(Icons.Outlined.Settings, contentDescription = "설정")
                        }
                    }
                }
            )
        },
        bottomBar = {
            if (activeRepo != null && !showingSettings) NavigationBar {
                Tab.entries.forEach { item ->
                    NavigationBarItem(
                        selected = tab == item,
                        onClick = { tab = item },
                        icon = { Icon(item.icon, contentDescription = null) },
                        label = { Text(item.title, fontSize = 11.sp) }
                    )
                }
            }
        }
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            ErrorText(error)
            if (showingSettings) {
                SettingsPage(api, prefs, onPrefs)
            } else if (activeRepo == null) {
                RepoListPage(repos, prefs.pcURL) { repo ->
                    selectedID = repo.id
                    target = null
                    tab = Tab.Changes
                }
            } else when (tab) {
                Tab.Changes -> ChangesPage(api, activeRepo.id, refresh) { path, scope ->
                    target = ReaderTarget(path, scope)
                }
                Tab.Files -> FilesPage(api, activeRepo.id, refresh, folder,
                    onFolder = { folder = it }) { path ->
                    target = ReaderTarget(path)
                }
                Tab.History -> HistoryPage(api, activeRepo.id, refresh) { path, hash ->
                    target = ReaderTarget(path, commit = hash)
                }
            }
        }
    }
}
@Composable
private fun ErrorText(error: String?) {
    if (!error.isNullOrBlank()) Text(
        error, color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodySmall,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
    )
}
@Composable
private fun RepoListPage(repos: List<RepoSummary>, url: String, open: (RepoSummary) -> Unit) {
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Text("PC", fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(Uri.parse(url).host.orEmpty(), fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(16.dp))
        Text("저장소", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(repos, key = { it.id }) { repo ->
                ElevatedCard(onClick = { if (repo.available) open(repo) },
                    modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Text(repo.name, fontWeight = FontWeight.SemiBold)
                        Text(if (repo.available)
                            (repo.branch ?: "") + "  •  변경 " + repo.changeCount + "개"
                            else if (repo.issue == "temporary") "일시적으로 상태를 조회할 수 없음"
                            else "접근할 수 없음",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}
@Composable
private fun ChangesPage(api: PrismoAPI, id: String, refresh: Int,
                        open: (String, String?) -> Unit) {
    var status by remember(id) { mutableStateOf<RepoStatus?>(null) }
    var error by remember(id) { mutableStateOf<String?>(null) }
    LaunchedEffect(api, id, refresh) {
        error = null
        try { status = api.status(id) }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) {
            error = "변경 목록을 불러올 수 없습니다."
        }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        Text("브랜치  " + (status?.branch ?: "—"),
            style = MaterialTheme.typography.titleMedium)
        Text("변경 파일 " + (status?.changes?.size ?: 0) + "개",
            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        ErrorText(error)
        if (status == null && error == null) LinearProgressIndicator(Modifier.fillMaxWidth())
        LazyColumn {
            items(status?.changes.orEmpty(), key = { it.path }) { change ->
                HorizontalDivider()
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)
                        .clickable { open(change.path, when {
                            change.kind == "conflicted" -> null
                            change.untracked -> "untracked"
                            change.unstaged -> "unstaged"
                            else -> "staged"
                        }) }.padding(vertical = 9.dp)) {
                        Text(change.path, fontSize = 13.sp, maxLines = 2,
                            overflow = TextOverflow.Ellipsis)
                        Text(if (change.kind == "conflicted") "충돌 · 작업 파일 열기" else change.kind,
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (change.staged) TextButton(onClick = { open(change.path, "staged") }) {
                        Text("S", fontSize = 12.sp)
                    }
                    if (change.unstaged) TextButton(onClick = { open(change.path, "unstaged") }) {
                        Text("W", fontSize = 12.sp)
                    }
                    if (change.untracked) TextButton(onClick = { open(change.path, "untracked") }) {
                        Text("U", fontSize = 12.sp)
                    }
                }
            }
        }
    }
}
@Composable
private fun FilesPage(api: PrismoAPI, id: String, refresh: Int, folder: String,
                      onFolder: (String) -> Unit, open: (String) -> Unit) {
    var entries by remember(id, folder) { mutableStateOf<List<TreeEntry>>(emptyList()) }
    var cursor by remember(id, folder) { mutableStateOf<String?>(null) }
    var nextCursor by remember(id, folder) { mutableStateOf<String?>(null) }
    var loading by remember(id, folder) { mutableStateOf(false) }
    var error by remember(id, folder) { mutableStateOf<String?>(null) }
    var reload by remember(id, folder) { mutableIntStateOf(0) }
    var pageRequestId by remember(id, folder) { mutableIntStateOf(0) }
    var loadedRefresh by remember(id, folder) { mutableIntStateOf(refresh) }
    LaunchedEffect(api, id, folder, refresh, reload, pageRequestId) {
        loading = true
        error = null
        val requestCursor = requestPageCursor(refresh, loadedRefresh, cursor)
        try {
            val page = api.tree(id, folder, requestCursor)
            entries = mergePage(entries, page.entries, requestCursor == null)
            nextCursor = page.nextCursor
            cursor = requestCursor
            loadedRefresh = refresh
            error = null
        } catch (e: CancellationException) { throw e }
        catch (e: HttpException) {
            if (e.code() == 410 && requestCursor != null) {
                cursor = null
                pageRequestId++
            } else {
                error = "파일 목록을 불러올 수 없습니다."
            }
        } catch (_: Exception) {
            error = "파일 목록을 불러올 수 없습니다."
        } finally {
            loading = false
        }
    }
    BackHandler(enabled = folder.isNotBlank()) {
        onFolder(folder.substringBeforeLast("/", ""))
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        Text("파일  / " + folder, style = MaterialTheme.typography.titleMedium)
        ErrorText(error)
        if (loading) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (error != null && !loading) {
            OutlinedButton(onClick = { reload++ }) { Text("다시 불러오기") }
        }
        LazyColumn {
            if (folder.isNotBlank()) item {
                Text("‹  상위 폴더", modifier = Modifier.fillMaxWidth().clickable {
                    onFolder(folder.substringBeforeLast("/", ""))
                }.padding(12.dp))
            }
            items(entries, key = { it.path }) { entry ->
                HorizontalDivider()
                Row(
                    Modifier.fillMaxWidth().clickable {
                        if (entry.directory) onFolder(entry.path) else open(entry.path)
                    }.padding(vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(if (entry.directory) "▸" else "·", modifier = Modifier.width(28.dp))
                    Text(entry.name, fontSize = 13.sp, maxLines = 2,
                        overflow = TextOverflow.Ellipsis)
                }
            }
            if (nextCursor != null) item {
                OutlinedButton(onClick = {
                    cursor = nextCursor
                    pageRequestId++
                }, enabled = !loading && error == null,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text("더 보기")
                }
            }
        }
    }
}
@Composable
private fun HistoryPage(api: PrismoAPI, id: String, refresh: Int,
                        open: (String, String) -> Unit) {
    var commits by remember(id) { mutableStateOf<List<Commit>>(emptyList()) }
    var cursor by remember(id) { mutableStateOf<String?>(null) }
    var nextCursor by remember(id) { mutableStateOf<String?>(null) }
    var loading by remember(id) { mutableStateOf(false) }
    var selectedHash by remember(id) { mutableStateOf<String?>(null) }
    var selectedFiles by remember(id) { mutableStateOf<Pair<String, List<String>>?>(null) }
    var pageError by remember(id) { mutableStateOf<String?>(null) }
    var fileError by remember(id) { mutableStateOf<String?>(null) }
    var reload by remember(id) { mutableIntStateOf(0) }
    var fileReload by remember(id) { mutableIntStateOf(0) }
    var pageRequestId by remember(id) { mutableIntStateOf(0) }
    var loadedRefresh by remember(id) { mutableIntStateOf(refresh) }
    LaunchedEffect(api, id, refresh, reload, pageRequestId) {
        loading = true
        pageError = null
        val requestCursor = requestPageCursor(refresh, loadedRefresh, cursor)
        try {
            val page = api.commits(id, requestCursor)
            commits = mergePage(commits, page.commits, requestCursor == null)
            nextCursor = page.nextCursor
            cursor = requestCursor
            loadedRefresh = refresh
            if (requestCursor == null) {
                selectedHash = null
                selectedFiles = null
            }
        } catch (e: CancellationException) { throw e }
        catch (e: HttpException) {
            if (requestCursor != null && e.code() == 404) {
                cursor = null
                pageRequestId++
            }
            else pageError = "커밋 기록을 불러올 수 없습니다."
        } catch (_: Exception) {
            pageError = "커밋 기록을 불러올 수 없습니다."
        } finally {
            loading = false
        }
    }
    LaunchedEffect(api, id, selectedHash, fileReload) {
        val hash = selectedHash
        fileError = null
        if (hash != null) try {
            selectedFiles = hash to api.commitFiles(id, hash).files
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) {
            fileError = "커밋 파일을 불러올 수 없습니다."
        }
    }
    BackHandler(enabled = selectedHash != null) {
        selectedHash = null
        selectedFiles = null
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp)) {
        Text("커밋 기록", style = MaterialTheme.typography.titleMedium)
        ErrorText(pageError)
        if (pageError != null && !loading) {
            OutlinedButton(onClick = { reload++ }) { Text("다시 불러오기") }
        }
        LazyColumn {
            items(commits, key = { it.hash }) { commit ->
                HorizontalDivider()
                Column(Modifier.fillMaxWidth().clickable {
                    selectedHash = if (selectedHash == commit.hash) null else commit.hash
                    selectedFiles = null
                    fileError = null
                }.padding(vertical = 10.dp)) {
                    Text(commit.subject, fontSize = 14.sp, fontWeight = FontWeight.SemiBold)
                    Text(commit.hash.take(8) + "  •  " + commit.author,
                        fontSize = 11.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (selectedHash == commit.hash) {
                    if (fileError != null) {
                        ErrorText(fileError)
                        OutlinedButton(onClick = { fileReload++ }) { Text("커밋 파일 다시 불러오기") }
                    }
                    if (selectedFiles?.first != commit.hash && fileError == null) {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                    }
                    selectedFiles?.takeIf { it.first == commit.hash }?.second.orEmpty().forEach { path ->
                        Text("  ↳ " + path, fontSize = 12.sp,
                            modifier = Modifier.fillMaxWidth().clickable {
                                open(path, commit.hash)
                            }.padding(vertical = 8.dp, horizontal = 8.dp))
                    }
                }
            }
            if (nextCursor != null) item {
                OutlinedButton(onClick = {
                    cursor = nextCursor
                    pageRequestId++
                }, enabled = !loading && pageError == null,
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
                    Text("더 보기")
                }
            }
            if (loading) item {
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }
    }
}
@Composable
private fun SettingsPage(api: PrismoAPI, prefs: ViewerPreferences,
                         onPrefs: ((ViewerPreferences) -> ViewerPreferences) -> Unit) {
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    var updateState by remember(api) { mutableStateOf<UpdateState>(UpdateState.Checking) }
    var checking by remember(api) { mutableIntStateOf(0) }
    LaunchedEffect(api, checking) {
        updateState = UpdateState.Checking
        updateState = try {
            val response = api.update()
            val latest = response.update
            when {
                !response.configured -> UpdateState.Unconfigured
                latest == null -> UpdateState.NotPublished
                latest.packageName != context.packageName ||
                    latest.versionCode <= AppUpdater.installedVersionCode(context) -> UpdateState.Current
                else -> UpdateState.Available(latest)
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) {
            UpdateState.Failed
        }
    }
    val updateStatus = when (val current = updateState) {
        UpdateState.Checking -> "확인 중"
        UpdateState.Unconfigured -> "업데이트 준비 전"
        UpdateState.NotPublished -> "업데이트 없음"
        UpdateState.Current -> "최신 버전"
        UpdateState.Failed -> "업데이트할 수 없습니다."
        is UpdateState.Available -> "새 버전 " + current.info.versionName
        is UpdateState.PermissionRequired -> "설치 권한을 허용한 뒤 다시 눌러주세요."
        UpdateState.Downloading -> "다운로드 중"
        UpdateState.InstallPending -> "설치 확인"
    }
    val availableUpdate = when (val current = updateState) {
        is UpdateState.Available -> current.info
        is UpdateState.PermissionRequired -> current.info
        else -> null
    }
    var noticePath by remember { mutableStateOf<String?>(null) }
    val currentNotice = noticePath
    BackHandler(enabled = currentNotice != null) { noticePath = null }
    if (currentNotice != null) {
        val notices = remember(context, currentNotice) {
            context.assets.open(currentNotice).bufferedReader().use { it.readText() }
        }
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp)) {
            TextButton(onClick = { noticePath = null }) { Text("‹ 설정") }
            Text("오픈소스 라이선스", style = MaterialTheme.typography.titleLarge)
            Text(notices, fontSize = 12.sp, lineHeight = 17.sp)
        }
        return
    }
    var font by remember(prefs.fontSize) { mutableFloatStateOf(prefs.fontSize.toFloat()) }
    var height by remember(prefs.lineHeight) { mutableFloatStateOf(prefs.lineHeight) }
    var padding by remember(prefs.padding) { mutableFloatStateOf(prefs.padding.toFloat()) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp)
    ) {
        Text("코드 표시", style = MaterialTheme.typography.titleLarge)
        Text("글자 크기  " + font.roundToInt() + " px")
        Slider(value = font, onValueChange = { font = it },
            valueRange = 10f..20f, steps = 9,
            onValueChangeFinished = { onPrefs { it.copy(fontSize = font.roundToInt()) } })
        Text("줄 높이  " + String.format("%.1f", height))
        Slider(value = height, onValueChange = { height = it },
            valueRange = 1.1f..1.8f,
            onValueChangeFinished = { onPrefs { it.copy(lineHeight = height) } })
        Text("좌우 여백  " + padding.roundToInt() + " px")
        Slider(value = padding, onValueChange = { padding = it },
            valueRange = 2f..16f, steps = 13,
            onValueChangeFinished = { onPrefs { it.copy(padding = padding.roundToInt()) } })
        SettingSwitch("긴 코드 줄바꿈", prefs.wrap) { enabled -> onPrefs { it.copy(wrap = enabled) } }
        SettingSwitch("줄 번호 표시", prefs.numbers) { enabled -> onPrefs { it.copy(numbers = enabled) } }
        SettingSwitch("좌우 비교 Diff", prefs.split) { enabled -> onPrefs { it.copy(split = enabled) } }
        SettingSwitch("다크 테마", prefs.dark) { enabled -> onPrefs { it.copy(dark = enabled) } }
        HorizontalDivider()
        Text("앱 업데이트", style = MaterialTheme.typography.titleMedium)
        Text(updateStatus, color = MaterialTheme.colorScheme.onSurfaceVariant,
            fontSize = 12.sp)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = { checking++ },
                enabled = updateState != UpdateState.Checking && updateState != UpdateState.Downloading) {
                Text("확인")
            }
            if (availableUpdate != null) {
                Button(onClick = {
                    if (!AppUpdater.canInstall(context)) {
                        updateState = UpdateState.PermissionRequired(availableUpdate)
                        AppUpdater.requestInstallPermission(context)
                    } else {
                        coroutineScope.launch {
                            updateState = UpdateState.Downloading
                            try {
                                val apk = AppUpdater.downloadAndVerify(context, api, availableUpdate)
                                updateState = UpdateState.InstallPending
                                AppUpdater.install(context, apk)
                            } catch (e: CancellationException) { throw e }
                            catch (_: Exception) {
                                updateState = UpdateState.Failed
                            }
                        }
                    }
                }) {
                    Text("업데이트")
                }
            }
        }
        HorizontalDivider()
        Text("연결된 PC", style = MaterialTheme.typography.titleMedium)
        Text(prefs.pcURL, fontSize = 12.sp)
        HorizontalDivider()
        Text("오픈소스 라이선스", style = MaterialTheme.typography.titleMedium)
        OutlinedButton(onClick = { noticePath = "android-library-notices.txt" }) {
            Text("Android 라이브러리 라이선스")
        }
        OutlinedButton(onClick = { noticePath = "renderer-licenses.txt" }) {
            Text("Diff / 코드 렌더러 라이선스")
        }
        OutlinedButton(onClick = { onPrefs { it.copy(pcURL = "", deviceToken = "") } }) {
            Text("PC 연결 정보 삭제")
        }
    }
}
@Composable
private fun SettingSwitch(label: String, checked: Boolean, onChanged: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, modifier = Modifier.weight(1f), fontSize = 14.sp)
        Switch(checked = checked, onCheckedChange = onChanged)
    }
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ReaderPage(
    api: PrismoAPI, id: String, target: ReaderTarget,
    prefs: ViewerPreferences, onBack: () -> Unit
) {
    val hasDiff = target.scope != null || target.commit != null
    var mode by remember(target) { mutableStateOf(if (hasDiff) "diff" else "file") }
    var result by remember(target, mode) { mutableStateOf<ReaderResult>(ReaderResult.Loading) }
    var retry by remember(target, mode) { mutableIntStateOf(0) }
    LaunchedEffect(api, id, target, mode, retry) {
        result = ReaderResult.Loading
        try {
            val content = when {
                target.commit != null && mode == "diff" ->
                    api.commitDiff(id, target.commit, target.path).diff
                target.commit != null ->
                    api.commitFile(id, target.commit, target.path).content
                target.scope != null && mode == "diff" ->
                    api.diff(id, target.scope, target.path).diff
                else -> api.file(id, target.path,
                    if (target.scope == "staged") "index" else null).content
            }
            result = if (content == null) ReaderResult.Missing else ReaderResult.Content(content)
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { result = ReaderResult.Failed }
    }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(target.path.substringAfterLast("/"),
                style = MaterialTheme.typography.titleMedium) },
            navigationIcon = { TextButton(onClick = onBack) { Text("‹") } }
        )
    }) { pad ->
        Column(Modifier.fillMaxSize().padding(pad)) {
            Text(target.path, modifier = Modifier.padding(horizontal = 12.dp),
                fontSize = 11.sp, maxLines = 2,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.padding(horizontal = 8.dp)) {
                if (hasDiff) TextButton(onClick = { mode = "diff" }) {
                    Text(if (mode == "diff") "● 변경" else "변경", fontSize = 12.sp)
                }
                TextButton(onClick = { mode = "file" }) {
                    Text(if (mode == "file") "● 파일" else "파일", fontSize = 12.sp)
                }
                TextButton(onClick = { mode = "raw" }) {
                    Text(if (mode == "raw") "● 원문" else "원문", fontSize = 12.sp)
                }
            }
            when (val current = result) {
                ReaderResult.Loading -> LinearProgressIndicator(Modifier.fillMaxWidth())
                ReaderResult.Missing -> Text(
                    "선택한 버전에는 파일이 없습니다. 삭제 내용은 변경 화면에서 확인할 수 있습니다.",
                    modifier = Modifier.padding(16.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                ReaderResult.Failed -> Column {
                    ErrorText("파일을 읽을 수 없습니다.")
                    OutlinedButton(onClick = { retry++ }) { Text("다시 시도") }
                }
                is ReaderResult.Content -> CodeViewer(
                    path = target.path, mode = mode,
                    source = current.text, preferences = prefs,
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}
