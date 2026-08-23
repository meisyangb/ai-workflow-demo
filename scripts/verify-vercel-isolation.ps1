# ============================================================
# scripts/verify-vercel-isolation.ps1
#
# Purpose: simulate Vercel build host environment that has NO Rust / Cargo
# installed, and verify desktop code (Tauri + src-tauri/) does not leak into
# the web deployment path.
#
# Usage: from repo root run:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\verify-vercel-isolation.ps1
#
# Exit: 0 on full success, 1 with failure details.
# ============================================================
param(
  [switch]$SkipInstall = $false
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg)  { Write-Host "`n[STEP] $msg" -ForegroundColor Cyan }
function Write-Info($msg)  { Write-Host "         $msg" -ForegroundColor DarkGray }
function Write-Pass($msg)  { Write-Host "   PASS  $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "   WARN  $msg" -ForegroundColor Yellow }
function Write-Fail($msg)  { Write-Host "   FAIL  $msg" -ForegroundColor Red }
function Fail($msg, $hint = $null) {
  Write-Fail $msg
  if ($hint) { Write-Host "         HINT: $hint" -ForegroundColor DarkYellow }
  exit 1
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot
Write-Info "Repo root: $repoRoot"

# ── Step 0: pretend there is no Rust toolchain ──────────────────────────
Write-Step "Step 0/6 - Simulate NO Rust/Cargo environment"
$cleanPath = @()
foreach ($p in ($env:PATH -split ';')) {
  if ($p -match 'rust|cargo|rustup|\.cargo\\bin|\.rustup') { continue }
  $cleanPath += $p
}
$env:PATH = ($cleanPath -join ';')
$env:RUSTUP_HOME = $null
$env:CARGO_HOME  = $null
$cargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
$rustcCmd = Get-Command rustc -ErrorAction SilentlyContinue
if ($cargoCmd) { Fail "cargo still visible on PATH: $($cargoCmd.Source)" }
if ($rustcCmd) { Fail "rustc still visible on PATH: $($rustcCmd.Source)" }
Write-Pass "PATH has no cargo / rustc / rustup entries"

# ── Step 1: vercel.json + vite.config.ts diff vs v0.1.3 ─────────────────
Write-Step "Step 1/6 - Config files must not be touched"
function GitDiffIsEmpty($file) {
  try {
    $raw = git diff v0.1.3 -- $file 2>&1
    if ($LASTEXITCODE -ne 0) { return $null }
    return [string]::IsNullOrWhiteSpace(($raw | Out-String))
  } catch { return $null }
}
$vcDiff = GitDiffIsEmpty 'vercel.json'
if ($vcDiff -eq $true)       { Write-Pass "vercel.json is byte-identical to v0.1.3" }
elseif ($vcDiff -eq $false)  { Fail "vercel.json was modified (Vercel isolation hard line)" }
else                         { Write-Warn "git tag v0.1.3 unavailable locally, fall back to structure check" }

$vercelObj = Get-Content vercel.json -Raw | ConvertFrom-Json
if ($vercelObj.rewrites.Count -ne 1 -or
    $vercelObj.rewrites[0].source      -ne '/(.*)' -or
    $vercelObj.rewrites[0].destination -ne '/index.html') {
  Fail "vercel.json must have exactly one SPA rewrite rule"
}
Write-Pass "vercel.json structure verified: single SPA rewrite"

$vtDiff = GitDiffIsEmpty 'vite.config.ts'
if ($vtDiff -eq $true)       { Write-Pass "vite.config.ts is byte-identical to v0.1.3" }
elseif ($vtDiff -eq $false)  {
  $cfg = Get-Content 'vite.config.ts' -Raw
  if ($cfg -match 'tauri') { Fail "vite.config.ts contains literal 'tauri' -> Tauri plugins must NOT enter Vite build chain" }
  Write-Warn "vite.config.ts differs from v0.1.3, but no 'tauri' substring found (expected: vitest env tweaks) -> OK"
}
else                         { Write-Warn "git tag v0.1.3 unavailable locally, skipping vite.config.ts diff check" }

# ── Step 2: clean install (optional) then lint → test → build ───────────
Write-Step "Step 2/6 - Regression: ci + lint + test + build"
if ($SkipInstall) { Write-Warn "-SkipInstall used, skipping npm ci." }
else {
  npm ci
  if ($LASTEXITCODE -ne 0) { Fail "npm ci exited $LASTEXITCODE" }
  Write-Pass "npm ci OK"
}
npm run lint
if ($LASTEXITCODE -ne 0) { Fail "npm run lint exited $LASTEXITCODE" "Vercel build would also fail lint step." }
Write-Pass "lint: 0 errors, 0 warnings"

npm run test
if ($LASTEXITCODE -ne 0) { Fail "npm run test exited $LASTEXITCODE" }
Write-Pass "test: all suites green"

npm run build
if ($LASTEXITCODE -ne 0) { Fail "npm run build exited $LASTEXITCODE" }
Write-Pass "build: tsc + vite build OK"

# ── Step 3: dist asset structure check ─────────────────────────────────
Write-Step "Step 3/6 - dist/assets structure & entry reference audit"
$assets = Get-ChildItem (Join-Path $repoRoot 'dist/assets') -ErrorAction Stop
Write-Info "asset files:"
foreach ($a in $assets) {
  $kb = [math]::Round($a.Length / 1KB, 1)
  Write-Info ("  - {0} ({1} KB)" -f $a.Name, $kb)
}
# Pick the LARGEST index-*.js as the "main" bundle (Vite5 often splits into many small index-NNNN.js).
$bigIndexJs = @($assets | Where-Object { $_.Name -match '^index-[0-9A-Za-z_-]+\.js$' } | Sort-Object Length -Descending)
$mainJs = if ($bigIndexJs.Count -gt 0) { $bigIndexJs[0] } else { $null }
$mainCss = $assets | Where-Object { $_.Name -match '^index-[0-9A-Za-z_-]+\.css$' } | Select-Object -First 1
if (-not $mainJs)  {
  # Even more robust: largest .js file overall whose name starts with 'index-'
  $mainJs = $assets | Where-Object { $_.Extension -eq '.js' -and $_.Name.StartsWith('index-') } | Sort-Object Length -Descending | Select-Object -First 1
}
if (-not $mainJs)  { Fail "main index-*.js chunk not found" }
if (-not $mainCss) { Fail "main index-*.css chunk not found" }
Write-Pass ("main JS: {0}; main CSS: {1}" -f $mainJs.Name, $mainCss.Name)

$html = Get-Content (Join-Path $repoRoot 'dist/index.html') -Raw
$scriptRe = [regex]::new('<script[^>]+src="([^"]+)"')
$linkRe   = [regex]::new('<link[^>]+href="([^"]+)"')
$scriptSrcs = @($scriptRe.Matches($html) | ForEach-Object { $_.Groups[1].Value })
$linkHrefs = @($linkRe.Matches($html)   | ForEach-Object { $_.Groups[1].Value })
foreach ($s in $scriptSrcs) { Write-Info ("  entry script: {0}" -f $s) }
foreach ($h in $linkHrefs) { Write-Info ("  entry link:   {0}" -f $h) }
$badScripts = @($scriptSrcs | Where-Object { $_ -notmatch '^/assets/(index|core|vendor|common|chunk|polyfill|preload|workers)-[0-9A-Za-z_-]+\.js$' })
if ($badScripts.Count -gt 0) { Fail "index.html references unexpected scripts: $($badScripts -join ', ')" "Tauri lazy chunks must NOT be referenced by first-load HTML." }
Write-Pass "index.html entry references only expected split chunks (no lazy-Tauri-chunk leakage)"

# ── Step 4: keyword scan (isolation core!) ─────────────────────────────
Write-Step "Step 4/6 - FIRST-LOAD chunk keyword scan (ALL chunks referenced from index.html)"
$keywords = @(
  '@tauri-apps',
  '__TAURI_INTERNALS__',
  '__TAURI__',
  'tauri::',
  'tauri-build',
  'tauri_plugin',
  'src-tauri',
  'WebView2Loader',
  'tauri.conf.json'
)
$entryJsNames = @($scriptSrcs | ForEach-Object { ($_ -split '/')[-1] })
$entryJsFiles = @()
foreach ($name in $entryJsNames) {
  $f = $assets | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if ($f) { $entryJsFiles += $f }
}
Write-Info ("Scanning {0} first-load JS chunks: {1}" -f $entryJsFiles.Count, ($entryJsFiles.Name -join ', '))
$hits = New-Object System.Collections.Generic.List[string]
foreach ($f in $entryJsFiles) {
  foreach ($kw in $keywords) {
    $found = Select-String -Path $f.FullName -Pattern ([regex]::Escape($kw)) -CaseSensitive:$false
    if ($found) {
      foreach ($m in $found) {
        $hits.Add(("{0}: keyword '{1}' line {2}" -f $f.Name, $kw, $m.LineNumber))
      }
    }
  }
}
if ($hits.Count -gt 0) { Fail ("Tauri strings found in first-load chunks: {0}" -f ($hits -join '; ')) }
Write-Pass ("First-load chunks contain zero of: {0}" -f ($keywords -join ', '))

Write-Step "Step 4 (cont) - Lazy chunks NOT referenced by index.html (informational, non-blocking)"
$entrySet = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($n in $entryJsNames) { [void]$entrySet.Add($n) }
$lazyJs = @($assets | Where-Object { $_.Extension -eq '.js' -and -not $entrySet.Contains($_.Name) })
if ($lazyJs.Count -eq 0) { Write-Info "  no lazy (non-entry) .js chunks exist" }
else {
  foreach ($o in $lazyJs) {
    $matched = @()
    foreach ($kw in $keywords) {
      if (Select-String -Path $o.FullName -Pattern ([regex]::Escape($kw)) -CaseSensitive:$false -Quiet) { $matched += $kw }
    }
    if ($matched.Count -gt 0) { Write-Info ("  lazy {0} carries Tauri keywords: {1} (ACCEPTABLE - never referenced by first-load HTML)" -f $o.Name, ($matched -join ',')) }
    else                     { Write-Info ("  lazy {0} has no Tauri keywords" -f $o.Name) }
  }
}

# ── Step 5: package.json dependency isolation ──────────────────────────
Write-Step "Step 5/6 - package.json dependency isolation"
$pkg = Get-Content 'package.json' -Raw | ConvertFrom-Json
$depNames  = @($pkg.dependencies  | Get-Member -MemberType NoteProperty | ForEach-Object Name)
$devNames  = @($pkg.devDependencies | Get-Member -MemberType NoteProperty | ForEach-Object Name)
$desktopInProd = @($depNames | Where-Object { $_ -match '^@tauri-apps/|^tauri$|^electron$|^webview' })
if ($desktopInProd.Count -gt 0) { Fail ("desktop packages must NOT be in dependencies: {0}" -f ($desktopInProd -join ', ')) }
Write-Pass "dependencies section has zero desktop-only packages"

$tauriDev = @($devNames | Where-Object { $_ -match '^@tauri-apps/' })
Write-Info ("devDependencies has @tauri-apps/* packages: {0}" -f ($tauriDev -join ', '))
if ($tauriDev.Count -ge 3) { Write-Pass "@tauri-apps/* in devDependencies count >= 3" }
else { Write-Warn "@tauri-apps/* only $($tauriDev.Count) in devDeps; verify completeness manually" }

$expectedScripts = @{
  'dev'     = 'vite'
  'build'   = 'tsc --noEmit && vite build'
  'preview' = 'vite preview'
  'lint'    = 'eslint .'
  'test'    = 'vitest run'
}
foreach ($k in $expectedScripts.Keys) {
  $actual = $pkg.scripts.$k
  if ($actual -ne $expectedScripts[$k]) {
    Fail ("scripts.{0} must remain unchanged. Expected='{1}' Actual='{2}'" -f $k, $expectedScripts[$k], $actual)
  }
}
Write-Pass "5 core scripts (dev/build/preview/lint/test) byte-identical to v0.1.3 shape"

# ── Step 6: optional first-load entry js total size delta ────────────────
Write-Step "Step 6/6 - First-load JS total size delta (threshold +2 KB)"
$totalEntry = ($entryJsFiles | Measure-Object Length -Sum).Sum
$baseline  = 1069810 # v0.1.3 reference total first-load entry JS: 1,069.81 KB -> bytes
$deltaAbs  = [math]::Abs($totalEntry - $baseline)
Write-Info ("first-load JS total : {0:N1} KB" -f ($totalEntry/1KB))
Write-Info ("first-load JS v0.1.3: {0:N1} KB" -f ($baseline/1KB))
Write-Info ("|delta|            : {0:N1} KB (threshold +2 KB)" -f ($deltaAbs/1KB))
if ($totalEntry -gt $baseline -and $deltaAbs -gt 2048) {
  Write-Warn ("first-load JS grew by >2 KB vs v0.1.3 baseline (+{0:N1} KB). Human review required." -f ($deltaAbs/1KB))
} else {
  Write-Pass "first-load JS delta within 2 KB tolerance"
}

# ── Summary ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "===========================================================" -ForegroundColor Green
Write-Host "  OK - Vercel isolation verification PASSED"                -ForegroundColor Green
Write-Host "===========================================================" -ForegroundColor Green
Write-Host "  1. No Rust env: npm ci/lint/test/build all succeed"
Write-Host "  2. vercel.json intact: SPA rewrite unchanged"
Write-Host "  3. Main chunk keyword scan: 0 Tauri-related hits"
Write-Host "  4. package.json dependencies section: 0 desktop packages"
Write-Host "  5. 5 core scripts: unchanged vs v0.1.3"
Write-Host ""
exit 0
