# Benchmark: gitnexus incremental vs full rebuild on a synthetic repo.
# Findings are recorded by the harness; this script only produces the numbers.
param(
  [int]$Files = 1500,
  [string]$Root = 'D:\Project\gitnexus-plus\bench\big-repo',
  [int]$Touch = 5
)

$env:NODE_OPTIONS = '--max-old-space-size=8192'
$env:GITNEXUS_MEMORY = 'off'
$env:GITNEXUS_HOME = 'D:\Project\gitnexus-plus\bench\ghome-big'
New-Item -ItemType Directory -Path $env:GITNEXUS_HOME -Force | Out-Null

function New-Fixture {
  if (Test-Path $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
  New-Item -ItemType Directory -Path "$Root\src" -Force | Out-Null
  1..$Files | ForEach-Object {
    $i = $_
    $imports = if ($i -gt 1) { "import { f$($i-1) } from './mod$($i-1)';" } else { '' }
    $call = if ($i -gt 1) { "  return f$($i-1)(x) + $i;" } else { '  return x + 1;' }
    $body = @"
$imports
export interface Shape$i { id: number; name: string; tags: string[] }
export class Service$i {
  private cache = new Map<number, Shape$i>();
  constructor(private readonly seed: number = $i) {}
  load(id: number): Shape$i | undefined { return this.cache.get(id); }
  store(s: Shape$i): void { this.cache.set(s.id, s); }
  compute(x: number): number {
$call
  }
}
export function f$i(x: number): number { return new Service$i().compute(x); }
export const VALUE$i = $i * 2;
"@
    Set-Content -LiteralPath "$Root\src\mod$i.ts" -Value $body -Encoding utf8
  }
  Set-Content -LiteralPath "$Root\README.md" -Value "# big-repo`nScale fixture." -Encoding utf8
  Set-Content -LiteralPath "$Root\package.json" -Value '{"name":"big-repo","private":true,"type":"module"}' -Encoding utf8
  Push-Location $Root; git init -q 2>&1 | Out-Null; git add -A 2>&1 | Out-Null
  git -c user.email=b@x -c user.name=b commit -qm init 2>&1 | Out-Null; Pop-Location
}

function Measure-Run([string]$Label, [string[]]$Extra) {
  $t0 = Get-Date
  $out = & gitnexus analyze --index-only --skip-fts @Extra $Root 2>&1 | Out-String
  $code = $LASTEXITCODE
  $secs = ((Get-Date) - $t0).TotalSeconds
  $stats = ''
  if (Test-Path "$Root\.gitnexus\gitnexus.json") {
    try { $stats = ((Get-Content "$Root\.gitnexus\gitnexus.json" -Raw | ConvertFrom-Json).stats | ConvertTo-Json -Compress) } catch {}
  }
  $cacheEntries = 0
  if (Test-Path "$Root\.gitnexus\parse-cache") {
    $cacheEntries = (Get-ChildItem "$Root\.gitnexus\parse-cache" -File -Filter '*.v8' | Measure-Object).Count
  }
  "RESULT|$Label|exit=$code|seconds=$([math]::Round($secs,2))|cacheFiles=$cacheEntries|stats=$stats"
}

Write-Output "=== fixture: $Files files ==="
New-Fixture
Measure-Run 'COLD_FULL' @()

Write-Output "=== no changes, warm re-run ==="
Measure-Run 'WARM_NOCHANGE' @()

Write-Output "=== $Touch files modified + 1 added ==="
1..$Touch | ForEach-Object { Add-Content -LiteralPath "$Root\src\mod$_.ts" -Value "`nexport const T$($_)_ = true;" }
$newIndex = $Files + 1
Set-Content -LiteralPath "$Root\src\mod$newIndex.ts" -Value "export const NEW = $newIndex;" -Encoding utf8
Write-Output "changed paths: $((git -C $Root status --porcelain | Measure-Object).Count)"
Measure-Run 'WARM_INCREMENTAL' @()

Write-Output "=== forced full rebuild (--force) ==="
Measure-Run 'FORCE_FULL' @('--force')

Write-Output "=== no parse cache (--no-parse-cache) ==="
Measure-Run 'NO_PARSE_CACHE' @('--no-parse-cache')

Write-Output "=== DONE ==="
