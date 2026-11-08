param(
    [ValidateSet('agent','transport','interop','android-iroh','android-identity','android-ui','all')]
    [string]$Stage = 'transport',
    [string]$Serial = 'emulator-5554',
    [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$windows = $env:OS -eq 'Windows_NT'
$npm = if ($windows) { 'npm.cmd' } else { 'npm' }

function Assert-Exit([string]$Name) {
    if ($LASTEXITCODE -ne 0) { throw "$Name failed (exit code $LASTEXITCODE)" }
}
function Invoke-Agent {
    Write-Output '[agent] Fastify/Git API and cancellation'
    & $npm --prefix (Join-Path $root 'agent') test
    Assert-Exit 'Agent API'
}
function Invoke-Transport {
    Write-Output '[transport] Native Node Iroh / Agent / Git'
    & $npm --prefix (Join-Path $root 'desktop') run 'test:transport'
    Assert-Exit 'Native transport'
}
function Get-JnaDirectory {
    if (-not $windows) { throw 'Windows JNA setup is required for this interop stage' }
    $folder = Join-Path ([IO.Path]::GetTempPath()) 'prismo-jvm-iroh-native'
    $dll = Join-Path $folder 'jnidispatch.dll'
    $expectedDll = '5a7ff949f6d93d86491eb5b26b1cfc60051168a60622650224b89995ac420023'
    $expectedJar = 'a564158d28ab5127fc6a958028ed54279fe0999662c46425b6a3b09a2a52094d'
    if ((Test-Path -LiteralPath $dll) -and
        (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash -eq $expectedDll) {
        return $folder
    }
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    $archive = Join-Path $folder 'jna-5.15.0.jar'
    $download = $archive + '.download'
    $extracted = $dll + '.new'
    $url = 'https://repo.maven.apache.org/maven2/net/java/dev/jna/jna/5.15.0/jna-5.15.0.jar'
    try {
        if (-not (Test-Path -LiteralPath $archive) -or
            (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedJar) {
            Invoke-WebRequest -Uri $url -OutFile $download
            if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash -ne $expectedJar) {
                throw 'Downloaded JNA archive failed SHA-256 verification'
            }
            Move-Item -LiteralPath $download -Destination $archive -Force
        }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            $entry = $zip.GetEntry('com/sun/jna/win32-x86-64/jnidispatch.dll')
            if ($null -eq $entry) { throw 'Windows JNA native library missing' }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $extracted, $true)
        } finally { $zip.Dispose() }
        if ((Get-FileHash -LiteralPath $extracted -Algorithm SHA256).Hash -ne $expectedDll) {
            throw 'Extracted JNA library failed SHA-256 verification'
        }
        Move-Item -LiteralPath $extracted -Destination $dll -Force
        return $folder
    } finally {
        Remove-Item -LiteralPath $download, $extracted -Force -ErrorAction SilentlyContinue
    }
}
function Invoke-Interop {
    Write-Output '[interop] Kotlin/JVM native Iroh to Windows Node Iroh'
    $oldSmoke = $env:PRISMO_NATIVE_IROH_SMOKE
    $oldOnly = $env:PRISMO_INTEROP_ONLY
    $oldJava = $env:JAVA_TOOL_OPTIONS
    try {
        $env:PRISMO_NATIVE_IROH_SMOKE = '1'
        $env:PRISMO_INTEROP_ONLY = '1'
        $env:JAVA_TOOL_OPTIONS = '-Djna.boot.library.path=' + (Get-JnaDirectory)
        Invoke-Transport
    } finally {
        $env:PRISMO_NATIVE_IROH_SMOKE = $oldSmoke
        $env:PRISMO_INTEROP_ONLY = $oldOnly
        $env:JAVA_TOOL_OPTIONS = $oldJava
    }
}
function Invoke-AndroidInstrumentation([string]$Name) {
    $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    $adb = Join-Path $sdk 'platform-tools\adb.exe'
    if (-not (Test-Path -LiteralPath $adb)) { throw 'Android ADB not installed' }
    $devices = @(& $adb devices)
    if (-not @($devices | Where-Object { $_ -match ('^' + [regex]::Escape($Serial) + '\s+device\b') }).Count) {
        throw "Emulator $Serial must be running"
    }
    $oldSerial = $env:ANDROID_SERIAL
    try {
        $env:ANDROID_SERIAL = $Serial
        $gradle = Join-Path $root 'android\gradlew.bat'
        $gradleArgs = @('-p', (Join-Path $root 'android'),
            ':app:connectedDebugAndroidTest',
            "-Pandroid.testInstrumentationRunnerArguments.class=dev.prismo.app.$Name",
            '--console=plain')
        & $gradle @gradleArgs
        Assert-Exit $Name
    } finally { $env:ANDROID_SERIAL = $oldSerial }
}
function Invoke-AndroidIroh {
    Write-Output '[android-iroh] On-device native Iroh QUIC streams'
    Invoke-AndroidInstrumentation 'IrohAndroidNativeTest'
}
function Invoke-AndroidIdentity {
    Write-Output '[android-identity] Stable Retrofit API identity for Compose'
    Invoke-AndroidInstrumentation 'PrismoConnectionIdentityTest'
}
function Invoke-AndroidUI {
    Write-Output '[android-ui] Real emulator process / app launch smoke'
    $sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
    $adb = Join-Path $sdk 'platform-tools\adb.exe'
    if (-not (Test-Path -LiteralPath $adb)) { throw 'Android ADB not installed' }
    $connected = @(& $adb devices)
    if (-not @($connected | Where-Object { $_ -match ('^' + [regex]::Escape($Serial) + '\s+device\b') }).Count) {
        throw "Emulator $Serial must be booted and connected before testing"
    }
    $boot = (& $adb -s $Serial shell getprop sys.boot_completed) -join ''
    Assert-Exit 'ADB boot status'
    if ($boot.Trim() -ne '1') { throw "Emulator $Serial is not fully booted" }
    if (-not $SkipInstall) {
        $oldSerial = $env:ANDROID_SERIAL
        try {
            $env:ANDROID_SERIAL = $Serial
            $gradle = Join-Path $root 'android\gradlew.bat'
            & $gradle -p (Join-Path $root 'android') ':app:installDebug' '--console=plain'
            Assert-Exit 'Debug APK incremental install'
        } finally { $env:ANDROID_SERIAL = $oldSerial }
    }
    $package = 'dev.prismo.app'
    $installed = (& $adb -s $Serial shell pm path $package) -join ''
    if ($LASTEXITCODE -ne 0 -or $installed -notmatch 'package:') {
        throw 'Prismo is not installed; rerun android-ui without -SkipInstall'
    }
    & $adb -s $Serial shell input keyevent 82 | Out-Null
    & $adb -s $Serial shell am force-stop $package | Out-Null
    $start = @(& $adb -s $Serial shell am start -W -n "$package/.MainActivity")
    Assert-Exit 'Android app launch'
    if (-not @($start | Where-Object { $_ -match 'Status:\s*ok' }).Count) {
        throw ('Android activity launch did not succeed: ' + ($start -join '; '))
    }
    Start-Sleep -Seconds 3
    $pidLine = (& $adb -s $Serial shell pidof $package) -join ''
    if ($pidLine.Trim() -notmatch '^\d+') { throw 'Prismo process died after launch' }
    & $adb -s $Serial shell uiautomator dump /sdcard/prismo-boundary-ui.xml | Out-Null
    Assert-Exit 'Android UI hierarchy'
    $hierarchy = (& $adb -s $Serial exec-out cat /sdcard/prismo-boundary-ui.xml) -join ''
    Assert-Exit 'Android UI content'
    if (-not $hierarchy.Contains('package="dev.prismo.app"') -or
        -not $hierarchy.Contains('text="Prismo"')) {
        throw 'Prismo activity launched but its UI is not visible'
    }
    Write-Output "[android-ui] PASS: visible Prismo UI, PID=$($pidLine.Trim()), $Serial"
}
switch ($Stage) {
    'agent' { Invoke-Agent }
    'transport' { Invoke-Transport }
    'interop' { Invoke-Interop }
    'android-iroh' { Invoke-AndroidIroh }
    'android-identity' { Invoke-AndroidIdentity }
    'android-ui' { Invoke-AndroidUI }
    'all' {
        Invoke-Agent
        Invoke-Transport
        Invoke-Interop
        Invoke-AndroidIroh
        Invoke-AndroidIdentity
        Invoke-AndroidUI
    }
}
Write-Output "PASS: $Stage boundary"
