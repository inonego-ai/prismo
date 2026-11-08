package dev.prismo.app

import android.os.Bundle
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import computer.iroh.IrohAndroid
import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Difference
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material.icons.outlined.Info
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
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.flow.map
import java.net.URI
import java.io.IOException
import java.security.SecureRandom
import android.util.Base64
import retrofit2.HttpException
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        IrohAndroid.installAndroidContext(applicationContext)
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
    val path: String, val scope: String? = null, val commit: String? = null,
    val deleted: Boolean = false
)
private sealed interface UpdateState {
    data object Checking : UpdateState
    data object Unconfigured : UpdateState
    data object NotPublished : UpdateState
    data object Current : UpdateState
    data class Failed(val message: String, val info: AppUpdate? = null) : UpdateState
    data class Available(val info: AppUpdate) : UpdateState
    data class PermissionRequired(val info: AppUpdate) : UpdateState
    data object Downloading : UpdateState
    data object InstallPending : UpdateState
}
private sealed interface ReaderResult {
    data object Loading : ReaderResult
    data class Content(val text: String) : ReaderResult
    data class Picture(val bitmap: Bitmap) : ReaderResult
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
private class HistoryState(refresh: Int) {
    val commits = mutableStateOf<List<Commit>>(emptyList())
    val cursor = mutableStateOf<String?>(null)
    val nextCursor = mutableStateOf<String?>(null)
    val loading = mutableStateOf(false)
    val selectedHash = mutableStateOf<String?>(null)
    val selectedFiles = mutableStateOf<Pair<String, CommitFiles>?>(null)
    val pageError = mutableStateOf<String?>(null)
    val fileError = mutableStateOf<String?>(null)
    val reload = mutableIntStateOf(0)
    val fileReload = mutableIntStateOf(0)
    val pageRequestId = mutableIntStateOf(0)
    val loadedPageRequestId = mutableIntStateOf(-1)
    val loadedRefresh = mutableIntStateOf(refresh)
    val scroll = LazyListState()
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
            } else if (!Regex("[0-9a-f]{64}").matches(prefs.pcID) || prefs.deviceToken.isBlank()) {
                PairingScreen { url, token ->
                    scope.launch {
                        context.updateViewerPreferences {
                            it.copy(pcID = url, deviceToken = token)
                        }
                        PairingAttempt.clear(context)
                    }
                }
            } else {
                val connection = remember(prefs.pcID, prefs.deviceToken) {
                    PrismoClient.create(context, prefs.pcID, prefs.deviceToken)
                }
                DisposableEffect(connection) {
                    onDispose { connection.close() }
                }
                key(prefs.pcID, prefs.deviceToken) {
                    RepositoryHome(
                        api = connection, prefs = prefs,
                        onPrefs = { change ->
                            scope.launch { context.updateViewerPreferences(change) }
                        }
                    )
                }
            }
        }
    }
}
private data class PairCode(val pcID: String, val secret: String)
private fun parsePairCode(input: String): PairCode {
    val uri = URI(input.trim())
    require(uri.scheme == "prismo" && uri.host == "pair"
        && uri.port == -1 && uri.userInfo == null && uri.rawFragment == null
        && (uri.path.isNullOrBlank() || uri.path == "/")) {
        "올바른 QR 코드가 아닙니다."
    }
    val entries = uri.rawQuery?.split("&")?.map { it.split("=", limit = 2) }.orEmpty()
    require(entries.size == 3 && entries.all { it.size == 2 }) {
        "올바른 연결 주소가 아닙니다."
    }
    val fields = entries.associate { it[0] to it[1] }
    val pc = fields["pc"].orEmpty()
    val secret = fields["code"].orEmpty()
    require(fields.size == 3 && fields["v"] == "1" &&
        Regex("[0-9a-f]{64}").matches(pc) &&
        Regex("[A-Za-z0-9_-]{43}").matches(secret)) {
        "올바른 연결 주소가 아닙니다."
    }
    return PairCode(pc, secret)
}
private suspend fun verifyPairing(context: Context, pcID: String, token: String): Boolean {
    val connection = PrismoClient.create(context, pcID, token)
    return try {
        connection.repositories()
        true
    } catch (error: CancellationException) {
        throw error
    } catch (_: Exception) {
        false
    } finally {
        connection.close()
    }
}

@Composable
private fun PairingScreen(onConnected: (String, String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var input by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var showManual by rememberSaveable { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var ongoing by remember { mutableStateOf<Job?>(null) }
    LaunchedEffect(Unit) {
        val pending = PairingAttempt.read(context)
        if (pending != null) {
            busy = true
            try {
                if (verifyPairing(context, pending.first, pending.second)) {
                    onConnected(pending.first, pending.second)
                }
            } finally {
                busy = false
            }
        }
    }
    fun connect(raw: String) {
        if (busy) return
        busy = true
        error = null
        ongoing = scope.launch {
            try {
                val pairing = parsePairCode(raw)
                val connection = PrismoClient.create(context, pairing.pcID)
                try {
                    require(connection.health().service == "Prismo") { "연결할 수 없습니다." }
                    val deviceName = android.provider.Settings.Global.getString(
                        context.contentResolver, android.provider.Settings.Global.DEVICE_NAME)
                        ?.takeIf { it.isNotBlank() } ?: android.os.Build.MODEL
                    val secret = ByteArray(32).also { SecureRandom().nextBytes(it) }
                    val token = Base64.encodeToString(secret,
                        Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
                    PairingAttempt.save(context, pairing.pcID, token)
                    val paired = try {
                        connection.pair(PairRequest(pairing.secret, deviceName, token)).paired
                    } catch (error: IOException) {
                        if (!verifyPairing(context, pairing.pcID, token)) throw error
                        true
                    }
                    check(paired) { "Pairing was not accepted" }
                    onConnected(pairing.pcID, token)
                } finally {
                    connection.close()
                }
            } catch (exception: CancellationException) {
                throw exception
            } catch (_: Exception) {
                error = "연결할 수 없습니다."
            } finally {
                busy = false
                ongoing = null
            }
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
        if (busy && ongoing != null) {
            TextButton(onClick = { ongoing?.cancel() }) { Text("연결 취소") }
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
    var selectedID by rememberSaveable { mutableStateOf<String?>(null) }
    var tabName by rememberSaveable { mutableStateOf(Tab.Changes.name) }
    val tab = Tab.valueOf(tabName)
    var showingSettings by rememberSaveable { mutableStateOf(false) }
    var targetPath by rememberSaveable { mutableStateOf<String?>(null) }
    var targetScope by rememberSaveable { mutableStateOf<String?>(null) }
    var targetCommit by rememberSaveable { mutableStateOf<String?>(null) }
    var targetDeleted by rememberSaveable { mutableStateOf(false) }
    val target = targetPath?.let { ReaderTarget(it, targetScope, targetCommit, targetDeleted) }
    var refresh by rememberSaveable { mutableIntStateOf(0) }
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        var wasPaused = false
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_PAUSE -> wasPaused = true
                Lifecycle.Event.ON_RESUME -> if (wasPaused) {
                    wasPaused = false
                    refresh++
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    val changesScroll = key(selectedID) { androidx.compose.foundation.lazy.rememberLazyListState() }
    val filesScroll = key(selectedID) { androidx.compose.foundation.lazy.rememberLazyListState() }
    val history = remember(selectedID) { HistoryState(refresh) }
    val fileTree = remember(api, selectedID, refresh) { FileTreeState() }
    var collapsedChanges by rememberSaveable(selectedID) { mutableStateOf(emptyList<String>()) }
    var expandedFiles by rememberSaveable(selectedID) { mutableStateOf(emptyList<String>()) }
    fun toggleChangeFolder(path: String) {
        collapsedChanges = if (path in collapsedChanges) collapsedChanges - path
            else collapsedChanges + path
    }
    fun toggleFileFolder(path: String) {
        expandedFiles = if (path in expandedFiles) expandedFiles - path
            else expandedFiles + path
    }
    fun openReader(path: String, scope: String? = null, commit: String? = null,
                   deleted: Boolean = false) {
        targetPath = path
        targetScope = scope
        targetCommit = commit
        targetDeleted = deleted
    }
    fun closeReader() {
        targetPath = null
        targetScope = null
        targetCommit = null
        targetDeleted = false
    }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(api, refresh) {
        try {
            val loaded = api.repositories().repositories
            repos = loaded
            if (selectedID != null && loaded.none { it.id == selectedID }) {
                selectedID = null
                closeReader()
            }
            error = null
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) {
            when {
                e is HttpException && e.code() == 401 ->
                    onPrefs { it.copy(pcID = "", deviceToken = "") }
                e is HttpException -> error = "저장소를 불러올 수 없습니다."
                else -> error = "PC에 연결할 수 없습니다."
            }
        } finally { initialLoad = false }
    }
    val activeRepo = repos.find { it.id == selectedID }
    BackHandler(enabled = target != null || showingSettings || activeRepo != null) {
        when {
            target != null -> closeReader()
            showingSettings -> showingSettings = false
            activeRepo != null -> { selectedID = null; closeReader() }
        }
    }
    if (initialLoad) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        return
    }
    if (activeRepo != null && target != null) {
        ReaderPage(api, activeRepo.id, target, prefs, refresh, onBack = { closeReader() })
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
                    } else if (activeRepo != null) TextButton(onClick = { selectedID = null; closeReader() }) {
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
                        onClick = { tabName = item.name },
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
                RepoListPage(api, repos, refresh) { repo ->
                    selectedID = repo.id
                    closeReader()
                    tabName = Tab.Changes.name
                }
            } else when (tab) {
                Tab.Changes -> ChangesPage(api, activeRepo.id, refresh,
                    changesScroll, collapsedChanges, ::toggleChangeFolder) { path, scope, deleted ->
                    openReader(path, scope, deleted = deleted)
                }
                Tab.Files -> GitFilesTree(api, activeRepo.id, refresh,
                    fileTree, filesScroll, expandedFiles, ::toggleFileFolder) { path ->
                    openReader(path)
                }
                Tab.History -> HistoryPage(api, activeRepo.id, refresh, history) { path, hash, deleted ->
                    openReader(path, commit = hash, deleted = deleted)
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
private fun RepoListPage(
    api: PrismoAPI, repos: List<RepoSummary>, refresh: Int,
    open: (RepoSummary) -> Unit
) {
    val statuses = remember(api, refresh) { mutableStateMapOf<String, RepoStatus>() }
    val unavailable = remember(api, refresh) { mutableStateMapOf<String, Boolean>() }
    val slots = remember(api) { Semaphore(2) }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Text("PC", fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("등록됨", fontWeight = FontWeight.SemiBold)

        Spacer(Modifier.height(16.dp))
        Text("저장소", style = MaterialTheme.typography.titleLarge)
        Spacer(Modifier.height(8.dp))
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(repos, key = { it.id }) { repo ->
                LaunchedEffect(api, repo.id, refresh) {
                    if (!statuses.containsKey(repo.id) && !unavailable.containsKey(repo.id)) {
                        try {
                            statuses[repo.id] = slots.withPermit { api.status(repo.id) }
                        } catch (exception: CancellationException) {
                            throw exception
                        } catch (_: Exception) {
                            unavailable[repo.id] = true
                        }
                    }
                }
                ElevatedCard(onClick = { open(repo) },
                    modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(14.dp)) {
                        Text(repo.name, fontWeight = FontWeight.SemiBold)
                        Text(when {
                            statuses[repo.id] != null -> {
                                val status = requireNotNull(statuses[repo.id])
                                status.branch + "  •  변경 " + status.changes.size + "개"
                            }
                            unavailable[repo.id] == true -> "상태 조회 불가"
                            else -> "상태 확인 중"
                        }, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}
@Composable
private fun ChangesPage(
    api: PrismoAPI, id: String, refresh: Int,
    scroll: androidx.compose.foundation.lazy.LazyListState,
    collapsed: List<String>, onToggle: (String) -> Unit,
    open: (String, String?, Boolean) -> Unit
) {
    var status by remember(id) { mutableStateOf<RepoStatus?>(null) }
    var error by remember(id) { mutableStateOf<String?>(null) }
    var loading by remember(id) { mutableStateOf(false) }
    LaunchedEffect(api, id, refresh) {
        loading = true
        error = null
        try {
            status = api.status(id)
        } catch (exception: CancellationException) {
            throw exception
        } catch (_: Exception) {
            error = "변경 목록을 불러올 수 없습니다."
        } finally {
            loading = false
        }
    }
    Column(Modifier.fillMaxSize()) {
        ErrorText(error)
        val current = status
        if (current == null && error == null) {
            Row(Modifier.fillMaxWidth().padding(16.dp),
                verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(12.dp))
                Text("PC에서 변경 목록을 불러오는 중…", fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (current != null) {
            if (loading) {
                Text("변경 목록 새로고침 중…", modifier = Modifier.padding(horizontal = 16.dp),
                    fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                LinearProgressIndicator(Modifier.fillMaxWidth())
            }
            GitChangesTree(current, scroll, collapsed, onToggle, open)
        }
    }
}
@Composable
private fun HistoryPage(api: PrismoAPI, id: String, refresh: Int, history: HistoryState,
                        open: (String, String, Boolean) -> Unit) {
    var commits by history.commits
    var cursor by history.cursor
    var nextCursor by history.nextCursor
    var loading by history.loading
    var selectedHash by history.selectedHash
    var selectedFiles by history.selectedFiles
    var pageError by history.pageError
    var fileError by history.fileError
    var reload by history.reload
    var fileReload by history.fileReload
    var pageRequestId by history.pageRequestId
    var loadedPageRequestId by history.loadedPageRequestId
    var loadedRefresh by history.loadedRefresh
    LaunchedEffect(api, id, refresh, reload, pageRequestId) {
        if (loadedRefresh == refresh && loadedPageRequestId == pageRequestId) return@LaunchedEffect
        loading = true
        pageError = null
        val requestCursor = requestPageCursor(refresh, loadedRefresh, cursor)
        try {
            val page = api.commits(id, requestCursor)
            commits = mergePage(commits, page.commits, requestCursor == null)
            nextCursor = page.nextCursor
            cursor = requestCursor
            loadedRefresh = refresh
            loadedPageRequestId = pageRequestId
            if (requestCursor == null) {
                selectedHash = null
                selectedFiles = null
                fileError = null
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
        if (hash != null && selectedFiles?.first == hash) return@LaunchedEffect
        fileError = null
        selectedFiles = null
        if (hash != null) try {
            val listing = api.commitFiles(id, hash)
            requireNotNull(listing.deletedFiles) { "Invalid commit files response" }
            selectedFiles = hash to listing
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
        LazyColumn(state = history.scroll) {
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
                    selectedFiles?.takeIf { it.first == commit.hash }?.second?.let { changes ->
                        changes.files.forEach { path ->
                            Text("  ↳ " + path, fontSize = 12.sp,
                                modifier = Modifier.fillMaxWidth().clickable {
                                    open(path, commit.hash, path in changes.deletedFiles)
                                }.padding(vertical = 8.dp, horizontal = 8.dp))
                        }
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
            UpdateState.Failed("업데이트 정보를 확인할 수 없습니다.")
        }
    }
    val updateStatus = when (val current = updateState) {
        UpdateState.Checking -> "확인 중"
        UpdateState.Unconfigured -> "업데이트 준비 전"
        UpdateState.NotPublished -> "업데이트 없음"
        UpdateState.Current -> "최신 버전"
        is UpdateState.Failed -> current.message
        is UpdateState.Available -> "새 버전 " + current.info.versionName
        is UpdateState.PermissionRequired -> "설치 권한을 허용한 뒤 다시 눌러주세요."
        UpdateState.Downloading -> "다운로드 중"
        UpdateState.InstallPending -> "설치 확인"
    }
    val availableUpdate = when (val current = updateState) {
        is UpdateState.Available -> current.info
        is UpdateState.PermissionRequired -> current.info
        is UpdateState.Failed -> current.info
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
    var markdownFont by remember(prefs.markdownFontSize) {
        mutableFloatStateOf(prefs.markdownFontSize.toFloat())
    }
    var height by remember(prefs.lineHeight) { mutableFloatStateOf(prefs.lineHeight) }
    var padding by remember(prefs.padding) { mutableFloatStateOf(prefs.padding.toFloat()) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp)
    ) {
        Text("코드 표시", style = MaterialTheme.typography.titleLarge)
        Text("글자 크기  " + font.roundToInt() + " px")
        Slider(value = font, onValueChange = { font = it },
            valueRange = 4f..20f, steps = 15,
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
        SettingSwitch("전체 파일 문맥 보기", prefs.fullDiff) {
            enabled -> onPrefs { it.copy(fullDiff = enabled) }
        }
        SettingSwitch("다크 테마", prefs.dark) { enabled -> onPrefs { it.copy(dark = enabled) } }
        HorizontalDivider()
        Text("MD 미리보기", style = MaterialTheme.typography.titleLarge)
        Text("글자 크기  " + markdownFont.roundToInt() + " px")
        Slider(value = markdownFont, onValueChange = { markdownFont = it },
            valueRange = 12f..32f, steps = 19,
            onValueChangeFinished = {
                onPrefs { it.copy(markdownFontSize = markdownFont.roundToInt()) }
            })
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
                            catch (e: Exception) {
                                val reason = when (e) {
                                    is IllegalArgumentException ->
                                        e.message ?: "업데이트 파일을 검증하지 못했습니다."
                                    is java.io.IOException -> "업데이트 파일을 다운로드하지 못했습니다."
                                    else -> "업데이트를 완료하지 못했습니다."
                                }
                                updateState = UpdateState.Failed(reason, availableUpdate)
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
        Text("등록됨", fontWeight = FontWeight.SemiBold)
        HorizontalDivider()
        Text("오픈소스 라이선스", style = MaterialTheme.typography.titleMedium)
        OutlinedButton(onClick = { noticePath = "android-library-notices.txt" }) {
            Text("Android 라이브러리 라이선스")
        }
        OutlinedButton(onClick = { noticePath = "renderer-licenses.txt" }) {
            Text("Diff / 코드 렌더러 라이선스")
        }
        OutlinedButton(onClick = { onPrefs { it.copy(pcID = "", deviceToken = "") } }) {
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
    prefs: ViewerPreferences, refresh: Int, onBack: () -> Unit
) {
    val hasDiff = target.scope != null || target.commit != null
    val fileName = target.path.substringAfterLast("/")
    val imageFile = fileName.substringAfterLast(".", "").lowercase() in
        setOf("png", "jpg", "jpeg", "gif", "webp")
    val markdownFile = fileName.substringAfterLast(".", "").lowercase() in
        setOf("md", "markdown")
    val suffix = fileName.substringAfterLast(".", "")
        .takeIf { it.isNotBlank() && fileName.substringBeforeLast(".").isNotEmpty() }
    val stem = if (suffix != null) fileName.dropLast(suffix.length + 1) else fileName
    val displayStem = if (stem.length > 24) stem.take(11) + "…" + stem.takeLast(10) else stem
    val folders = target.path.substringBeforeLast("/", "").split("/").filter { it.isNotEmpty() }
    val parentLabel = when {
        folders.isEmpty() -> "저장소 루트"
        folders.size > 3 -> "…  ›  " + folders.takeLast(3).joinToString("  ›  ")
        else -> folders.joinToString("  ›  ")
    }
    var showFullPath by rememberSaveable(target.path) { mutableStateOf(false) }
    var mode by rememberSaveable(target) {
        mutableStateOf(when {
            target.deleted && hasDiff -> "diff"
            imageFile -> "image"
            markdownFile -> "markdown"
            hasDiff -> "diff"
            else -> "file"
        })
    }
    val dataRevision = if (target.commit == null) refresh else 0
    var result by remember(target, mode, dataRevision) {
        mutableStateOf<ReaderResult>(ReaderResult.Loading)
    }
    var retry by remember(target, mode) { mutableIntStateOf(0) }
    LaunchedEffect(api, id, target, mode, dataRevision, retry, prefs.fullDiff) {
        result = ReaderResult.Loading
        try {
            if (mode == "image") {
                result = withContext(Dispatchers.IO) {
                    val call = api.image(id, target.path,
                        if (target.scope == "staged") "index" else null, target.commit)
                    val cancellationWatcher = launch(start = CoroutineStart.UNDISPATCHED) {
                        try { awaitCancellation() } finally { call.cancel() }
                    }
                    val bytes = try {
                        val response = call.execute()
                        if (!response.isSuccessful) {
                            response.errorBody()?.close()
                            throw HttpException(response)
                        }
                        requireNotNull(response.body()) { "Empty image response" }.use { it.bytes() }
                    } finally {
                        cancellationWatcher.cancel()
                    }
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    require(bounds.outWidth > 0 && bounds.outHeight > 0) {
                        "Invalid image"
                    }
                    var sample = 1
                    while (bounds.outWidth.toLong() * bounds.outHeight /
                        (sample.toLong() * sample) > 8_000_000
                        || bounds.outWidth / sample > 4096 || bounds.outHeight / sample > 4096) {
                        sample *= 2
                    }
                    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size,
                        BitmapFactory.Options().apply { inSampleSize = sample })
                        ?: throw IllegalArgumentException("Invalid image")
                    ReaderResult.Picture(bitmap)
                }
            } else {
                val content = when {
                    target.commit != null && mode == "diff" ->
                        api.commitDiff(id, target.commit, target.path, prefs.fullDiff).diff
                    target.commit != null ->
                        api.commitFile(id, target.commit, target.path).content
                    target.scope != null && mode == "diff" ->
                        api.diff(id, target.scope, target.path, prefs.fullDiff).diff
                    else -> api.file(id, target.path,
                        if (target.scope == "staged") "index" else null).content
                }
                result = if (content == null) ReaderResult.Missing else ReaderResult.Content(content)
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { result = ReaderResult.Failed }
    }
    if (showFullPath) {
        AlertDialog(
            onDismissRequest = { showFullPath = false },
            title = { Text("파일 경로") },
            text = { Text(target.path) },
            confirmButton = {
                TextButton(onClick = { showFullPath = false }) { Text("닫기") }
            }
        )
    }
    Scaffold(topBar = {
        Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surface)) {
            TopAppBar(
                title = {
                    Row(Modifier.fillMaxWidth().clickable { showFullPath = true },
                        verticalAlignment = Alignment.CenterVertically) {
                        Icon(gitFileIcon(fileName), contentDescription = null,
                            modifier = Modifier.size(18.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(8.dp))
                        Text(displayStem, modifier = Modifier.weight(1f, fill = false),
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1, overflow = TextOverflow.Ellipsis)
                        if (suffix != null) Text("." + suffix,
                            style = MaterialTheme.typography.titleMedium, maxLines = 1)
                    }
                },
                navigationIcon = { TextButton(onClick = onBack) { Text("‹") } }
            )
            Row(Modifier.fillMaxWidth().clickable { showFullPath = true }
                .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Outlined.Folder, contentDescription = null,
                    modifier = Modifier.size(15.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(6.dp))
                Text(parentLabel, modifier = Modifier.weight(1f),
                    fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Icon(Icons.Outlined.Info, contentDescription = "전체 경로 보기",
                    modifier = Modifier.size(15.dp),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp),
                modifier = Modifier.padding(horizontal = 8.dp)) {
                if (imageFile) {
                    if (target.deleted) {
                        TextButton(onClick = { mode = "diff" }) {
                            Text("● 변경", fontSize = 12.sp)
                        }
                    } else {
                        TextButton(onClick = { mode = "image" }) {
                            Text(if (mode == "image") "● 이미지" else "이미지", fontSize = 12.sp)
                        }
                    }
                } else {
                    if (markdownFile) TextButton(onClick = { mode = "markdown" }) {
                        Text(if (mode == "markdown") "● 미리보기" else "미리보기", fontSize = 12.sp)
                    }
                    if (hasDiff) TextButton(onClick = { mode = "diff" }) {
                        Text(if (mode == "diff") "● 변경" else "변경", fontSize = 12.sp)
                    }
                    TextButton(onClick = { mode = "file" }) {
                        Text(if (mode == "file") "● 코드" else "코드", fontSize = 12.sp)
                    }
                    TextButton(onClick = { mode = "raw" }) {
                        Text(if (mode == "raw") "● 원문" else "원문", fontSize = 12.sp)
                    }
                }
            }
        }
    }) { pad ->
        Box(Modifier.fillMaxSize().padding(pad)) {
            when (val current = result) {
                ReaderResult.Loading -> LinearProgressIndicator(Modifier.fillMaxWidth())
                ReaderResult.Missing -> Text(
                    "선택한 버전에는 파일이 없습니다. 삭제 내용은 변경 화면에서 확인할 수 있습니다.",
                    modifier = Modifier.padding(16.dp),
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                ReaderResult.Failed -> Column {
                    ErrorText(when (mode) {
                        "image" -> "이미지를 표시할 수 없습니다."
                        "diff" -> "변경 내용을 불러올 수 없습니다."
                        else -> "파일을 읽을 수 없습니다."
                    })
                    OutlinedButton(onClick = { retry++ }) { Text("다시 시도") }
                }
                is ReaderResult.Picture -> Image(
                    bitmap = current.bitmap.asImageBitmap(),
                    contentDescription = fileName,
                    modifier = Modifier.fillMaxSize().padding(12.dp),
                    contentScale = ContentScale.Fit
                )
                is ReaderResult.Content -> CodeViewer(
                    path = target.path, mode = mode,
                    source = current.text, preferences = prefs,
                    modifier = Modifier.fillMaxSize()
                )
            }
        }
    }
}
