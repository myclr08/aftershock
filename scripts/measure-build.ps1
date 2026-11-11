<#
.SYNOPSIS
    Aftershock M0: measures where the time goes in a .NET solution's build + test loop.

.DESCRIPTION
    Runs, one by one and with wall-clock timing:
      1. dotnet restore                                   (skipped with -SkipRestore)
      2. dotnet build --no-restore --no-incremental       (full rebuild of the solution)
      3. dotnet test --no-build                           (whole solution)
      4. the largest test project alone:
         a. no-op incremental build
         b. incremental build after touching (mtime only) one source file in a
            non-test project it references
         c. same as (b) with -p:RunAnalyzers=false -p:TreatWarningsAsErrors=false
    It also collects environment facts (SDK, OS, CPU count, test frameworks,
    coverage packages, CI pipeline hints) and writes a Markdown report to the
    current directory: aftershock-m0-<yyyyMMdd-HHmm>.md

    Safety:
      - Never changes file contents. The only change outside bin/obj is the
        last-write time of ONE source file, which is restored at the end
        (also on error or Ctrl+C).
      - Never runs git. No network access other than what `dotnet restore` does.
      - Raw logs and TRX files go to a temp folder, not into your repository.

    Works on Windows PowerShell 5.1 and PowerShell 7+. No admin rights, no modules.

.PARAMETER Solution
    .sln, .slnx or .slnf file. Default: the first .sln/.slnx in the current directory.

.PARAMETER TestProject
    Path to a test .csproj, or a project name from the solution.
    Default: the test project with the most .cs files.

.PARAMETER Configuration
    Build configuration. Default: Debug.

.PARAMETER SkipRestore
    Do not run `dotnet restore` (packages must already be restored).

.PARAMETER Anonymize
    Replace solution, project, assembly and file names with S1, P1, P2, ... in the report.

.PARAMETER TestFilter
    Optional `dotnet test --filter` expression for the whole-solution test run,
    e.g. "Category!=Integration" when integration tests need external resources.

.PARAMETER ExtraTestArgs
    Extra arguments for the whole-solution `dotnet test` run, as ONE string split on
    spaces, e.g. "--filter-not-trait Category=Integration" for xUnit v3 in
    Microsoft.Testing.Platform mode, where `--filter` is not available.

.PARAMETER Repeat
    How many times to repeat each incremental test-project build (a, b, c). Default: 1.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\measure-build.ps1 -Anonymize

.EXAMPLE
    pwsh ./measure-build.ps1 -Solution .\src\Big.sln -TestProject Big.UnitTests -Repeat 3
#>
[CmdletBinding()]
param(
    [string]$Solution,
    [string]$TestProject,
    [string]$Configuration = 'Debug',
    [switch]$SkipRestore,
    [switch]$Anonymize,
    [string]$TestFilter,
    [string]$ExtraTestArgs,
    [ValidateRange(1, 10)]
    [int]$Repeat = 1
)

$ErrorActionPreference = 'Stop'
$ScriptVersion = '1.0.0'

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

$script:OnWindows = ([System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT)
$script:Sep = [System.IO.Path]::DirectorySeparatorChar

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host ('== ' + $Text) -ForegroundColor Cyan
}

function Write-Info([string]$Text) {
    Write-Host ('   ' + $Text)
}

function Write-Warn([string]$Text) {
    Write-Host ('   WARNING: ' + $Text) -ForegroundColor Yellow
}

function Format-Duration([double]$Seconds) {
    if ($Seconds -lt 0) { return '-' }
    if ($Seconds -lt 60) { return ('{0:0.0} s' -f $Seconds) }
    $total = [int][Math]::Round($Seconds)
    $h = [int][Math]::Floor($total / 3600)
    $m = [int][Math]::Floor(($total % 3600) / 60)
    $s = $total % 60
    if ($h -gt 0) { return ('{0}h {1:00}m {2:00}s' -f $h, $m, $s) }
    return ('{0}m {1:00}s' -f $m, $s)
}

function Get-Median([double[]]$Values) {
    if (-not $Values -or $Values.Count -eq 0) { return -1 }
    $sorted = @($Values | Sort-Object)
    $n = $sorted.Count
    if ($n % 2 -eq 1) { return $sorted[[int](($n - 1) / 2)] }
    return ($sorted[$n / 2 - 1] + $sorted[$n / 2]) / 2.0
}

function Get-PathKey([string]$Path) {
    $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if ($script:OnWindows) { return $full.ToLowerInvariant() }
    return $full
}

function Test-PathUnder([string]$Path, [string]$Root) {
    $p = (Get-PathKey $Path) + $script:Sep
    $r = (Get-PathKey $Root) + $script:Sep
    return $p.StartsWith($r, [System.StringComparison]::Ordinal)
}

function Get-RelativePathSafe([string]$Path, [string]$Root) {
    $full = [System.IO.Path]::GetFullPath($Path)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (Test-PathUnder $full $rootFull) {
        $rel = $full.Substring($rootFull.Length).TrimStart('\', '/')
        if ($rel -eq '') { return '.' }
        return $rel.Replace('\', '/')
    }
    # Outside the root: show only the file name, never an absolute path.
    return ('(outside repo)/' + [System.IO.Path]::GetFileName($full))
}

function ConvertTo-NativePath([string]$Path) {
    if ($script:OnWindows) { return $Path.Replace('/', '\') }
    return $Path.Replace('\', '/')
}

function Read-TextFile([string]$Path) {
    try { return [System.IO.File]::ReadAllText($Path) } catch { return '' }
}

function ConvertTo-ArgString([string[]]$Arguments) {
    # Quote per CommandLineToArgvW rules (also used by .NET on Unix).
    $parts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($a in $Arguments) {
        if ($null -eq $a) { continue }
        if ($a -ne '' -and $a -notmatch '[\s"]') { $parts.Add($a); continue }
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('"')
        $backslashes = 0
        foreach ($ch in $a.ToCharArray()) {
            if ($ch -eq '\') { $backslashes++; continue }
            if ($ch -eq '"') {
                [void]$sb.Append('\' * ($backslashes * 2 + 1))
                [void]$sb.Append('"')
            } else {
                if ($backslashes -gt 0) { [void]$sb.Append('\' * $backslashes) }
                [void]$sb.Append($ch)
            }
            $backslashes = 0
        }
        if ($backslashes -gt 0) { [void]$sb.Append('\' * ($backslashes * 2)) }
        [void]$sb.Append('"')
        $parts.Add($sb.ToString())
    }
    return ($parts -join ' ')
}

function Invoke-NativeQuiet([string]$Exe, [string[]]$Arguments) {
    # Short, read-only native calls. Stderr is discarded; 'Continue' avoids
    # Windows PowerShell 5.1 turning stderr lines into terminating errors.
    $ErrorActionPreference = 'Continue'
    $out = @()
    $code = -1
    try {
        $out = @(& $Exe @Arguments 2>$null)
        $code = $LASTEXITCODE
    } catch { $code = -1 }
    return [pscustomobject]@{ Lines = $out; ExitCode = $code }
}

# ---------------------------------------------------------------------------
# Running dotnet with timing
# ---------------------------------------------------------------------------

$script:StepIndex = 0

function Invoke-Dotnet {
    param(
        [string]$Name,
        [string[]]$Arguments,
        [string]$WorkingDirectory
    )
    $script:StepIndex++
    $safeName = ($Name -replace '[^A-Za-z0-9]+', '-').Trim('-')
    $outLog = Join-Path $script:LogDir ('{0:00}-{1}.out.log' -f $script:StepIndex, $safeName)
    $errLog = Join-Path $script:LogDir ('{0:00}-{1}.err.log' -f $script:StepIndex, $safeName)
    $argString = ConvertTo-ArgString $Arguments

    Write-Info ('dotnet ' + $Arguments[0] + ' ...  (log: ' + [System.IO.Path]::GetFileName($outLog) + ')')

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $exitCode = -1
    $failure = $null
    try {
        # Output goes to files (not pipes) so MSBuild worker nodes / compiler server
        # that outlive dotnet cannot keep us waiting. We wait on the process only.
        $p = Start-Process -FilePath $script:DotnetPath -ArgumentList $argString `
            -WorkingDirectory $WorkingDirectory -NoNewWindow -PassThru `
            -RedirectStandardOutput $outLog -RedirectStandardError $errLog
        $null = $p.Handle   # cache the handle so ExitCode is available after exit
        $nextBeat = 30
        while (-not $p.WaitForExit(1000)) {
            if ($sw.Elapsed.TotalSeconds -ge $nextBeat) {
                Write-Info ('... still running (' + (Format-Duration $sw.Elapsed.TotalSeconds) + ')')
                $nextBeat += 30
            }
        }
        $p.WaitForExit()
        $exitCode = $p.ExitCode
        if ($null -eq $exitCode) { $exitCode = -1 }
    } catch {
        $failure = $_.Exception.Message
    }
    $sw.Stop()

    $result = [pscustomobject]@{
        Name      = $Name
        Command   = ('dotnet ' + $Arguments[0])
        Seconds   = $sw.Elapsed.TotalSeconds
        ExitCode  = $exitCode
        Ok        = ($exitCode -eq 0)
        OutLog    = $outLog
        ErrLog    = $errLog
        Failure   = $failure
        ErrorHint = ''
    }
    if (-not $result.Ok) {
        $result.ErrorHint = Get-ErrorHint $outLog $errLog
    }
    $status = 'OK'
    if (-not $result.Ok) { $status = ('exit code ' + $exitCode) }
    Write-Info ('-> ' + (Format-Duration $result.Seconds) + ', ' + $status)
    if ($failure) { Write-Warn $failure }
    $script:Steps.Add($result)
    return $result
}

function Get-ErrorHint([string]$OutLog, [string]$ErrLog) {
    # First MSBuild/NuGet error code(s), without paths or messages (they can contain URLs).
    $codes = New-Object 'System.Collections.Generic.List[string]'
    foreach ($f in @($OutLog, $ErrLog)) {
        if (-not (Test-Path -LiteralPath $f)) { continue }
        $text = Read-TextFile $f
        foreach ($m in [regex]::Matches($text, '\berror\s+([A-Z]{2,}\d{3,5})\b')) {
            $c = $m.Groups[1].Value
            if (-not $codes.Contains($c)) { $codes.Add($c) }
            if ($codes.Count -ge 5) { break }
        }
    }
    if ($codes.Count -gt 0) { return ('error codes: ' + ($codes -join ', ')) }
    return 'see local log'
}

# ---------------------------------------------------------------------------
# File system scan (one walk, prunes heavy folders, skips reparse points)
# ---------------------------------------------------------------------------

$script:PrunedDirs = @('bin', 'obj', 'node_modules', '.git', '.vs', '.idea', 'packages', 'TestResults', '.vscode-test')

function Invoke-TreeScan([string]$Root) {
    $result = [pscustomobject]@{
        ProjectFiles  = New-Object 'System.Collections.Generic.List[string]'
        PropsFiles    = New-Object 'System.Collections.Generic.List[string]'
        CiFiles       = New-Object 'System.Collections.Generic.List[string]'
        YamlFiles     = New-Object 'System.Collections.Generic.List[string]'
        RunSettings   = New-Object 'System.Collections.Generic.List[string]'
        OtherFiles    = New-Object 'System.Collections.Generic.List[string]'
        CsCountByDir  = @{}   # project dir key -> .cs count (files owned by the nearest project dir)
        TotalCsFiles  = 0
    }
    $stack = New-Object 'System.Collections.Generic.Stack[object]'
    $stack.Push(@($Root, $null))
    while ($stack.Count -gt 0) {
        $item = $stack.Pop()
        $dir = $item[0]
        $owner = $item[1]
        $files = @()
        try { $files = [System.IO.Directory]::GetFiles($dir) } catch { continue }

        $hasProject = $false
        foreach ($f in $files) {
            $name = [System.IO.Path]::GetFileName($f)
            $ext = [System.IO.Path]::GetExtension($f).ToLowerInvariant()
            if ($ext -eq '.csproj' -or $ext -eq '.fsproj' -or $ext -eq '.vbproj') {
                $result.ProjectFiles.Add($f); $hasProject = $true
            }
        }
        if ($hasProject) { $owner = Get-PathKey $dir }

        $cs = 0
        foreach ($f in $files) {
            $name = [System.IO.Path]::GetFileName($f)
            $lower = $name.ToLowerInvariant()
            $ext = [System.IO.Path]::GetExtension($lower)
            if ($ext -eq '.cs') { $cs++; continue }
            if ($lower -eq 'directory.build.props' -or $lower -eq 'directory.build.targets' -or $lower -eq 'directory.packages.props') {
                $result.PropsFiles.Add($f); continue
            }
            if ($ext -eq '.runsettings') { $result.RunSettings.Add($f); continue }
            if ($lower -like 'jenkinsfile*' -or $lower -eq '.gitlab-ci.yml' -or $lower -like 'azure-pipelines*.yml' -or $lower -like 'azure-pipelines*.yaml') {
                $result.CiFiles.Add($f); continue
            }
            if ($ext -eq '.yml' -or $ext -eq '.yaml') { $result.YamlFiles.Add($f); continue }
            if ($lower -eq 'global.json' -or $lower -eq 'sonar-project.properties' -or $lower -eq 'sonarqube.analysis.xml' -or $lower -eq 'dotnet-tools.json' -or $lower -eq 'nuget.config') {
                $result.OtherFiles.Add($f); continue
            }
        }
        if ($cs -gt 0) {
            $result.TotalCsFiles += $cs
            if ($owner) {
                if ($result.CsCountByDir.ContainsKey($owner)) { $result.CsCountByDir[$owner] += $cs } else { $result.CsCountByDir[$owner] = $cs }
            }
        }

        $subdirs = @()
        try { $subdirs = [System.IO.Directory]::GetDirectories($dir) } catch { $subdirs = @() }
        foreach ($d in $subdirs) {
            $dn = [System.IO.Path]::GetFileName($d)
            $skip = $false
            foreach ($p in $script:PrunedDirs) { if ($dn -ieq $p) { $skip = $true; break } }
            if ($skip) { continue }
            try {
                $attr = [System.IO.File]::GetAttributes($d)
                if (($attr -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
            } catch { continue }
            $stack.Push(@($d, $owner))
        }
    }
    return $result
}

# ---------------------------------------------------------------------------
# Solution and project parsing
# ---------------------------------------------------------------------------

function Get-SolutionProjects([string]$SolutionPath) {
    $ext = [System.IO.Path]::GetExtension($SolutionPath).ToLowerInvariant()
    $slnDir = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($SolutionPath))
    $paths = New-Object 'System.Collections.Generic.List[string]'

    if ($ext -eq '.slnf') {
        $json = (Read-TextFile $SolutionPath) | ConvertFrom-Json
        $inner = ConvertTo-NativePath ([string]$json.solution.path)
        $innerFull = [System.IO.Path]::GetFullPath((Join-Path $slnDir $inner))
        $innerDir = [System.IO.Path]::GetDirectoryName($innerFull)
        foreach ($p in $json.solution.projects) {
            $paths.Add([System.IO.Path]::GetFullPath((Join-Path $innerDir (ConvertTo-NativePath ([string]$p)))))
        }
    } elseif ($ext -eq '.slnx') {
        $doc = New-Object System.Xml.XmlDocument
        $doc.Load($SolutionPath)
        foreach ($node in $doc.SelectNodes('//Project')) {
            $rel = $node.GetAttribute('Path')
            if ($rel) { $paths.Add([System.IO.Path]::GetFullPath((Join-Path $slnDir (ConvertTo-NativePath $rel)))) }
        }
    } else {
        $text = Read-TextFile $SolutionPath
        $rx = 'Project\("\{[^}]+\}"\)\s*=\s*"[^"]*"\s*,\s*"([^"]+)"'
        foreach ($m in [regex]::Matches($text, $rx)) {
            $rel = $m.Groups[1].Value
            if ($rel -match '\.(cs|fs|vb)proj$') {
                $paths.Add([System.IO.Path]::GetFullPath((Join-Path $slnDir (ConvertTo-NativePath $rel))))
            }
        }
    }
    $seen = @{}
    $unique = New-Object 'System.Collections.Generic.List[string]'
    foreach ($p in $paths) {
        if ($p -notmatch '\.(cs|fs|vb)proj$') { continue }
        $k = Get-PathKey $p
        if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; $unique.Add($p) }
    }
    return ,$unique
}

function Get-PackageRefs([string]$Text) {
    # Returns objects: Kind (PackageReference|PackageVersion|GlobalPackageReference), Name, Version
    $list = New-Object 'System.Collections.Generic.List[object]'
    $rx = '<(PackageReference|PackageVersion|GlobalPackageReference)\b([^>]*?)(/?)>'
    foreach ($m in [regex]::Matches($Text, $rx, 'IgnoreCase')) {
        $attrs = $m.Groups[2].Value
        $name = $null
        $nm = [regex]::Match($attrs, '\b(?:Include|Update)\s*=\s*"([^"]+)"', 'IgnoreCase')
        if ($nm.Success) { $name = $nm.Groups[1].Value.Trim() }
        if (-not $name) { continue }
        $ver = ''
        $vm = [regex]::Match($attrs, '\b(?:Version|VersionOverride)\s*=\s*"([^"]*)"', 'IgnoreCase')
        if ($vm.Success) {
            $ver = $vm.Groups[1].Value
        } elseif ($m.Groups[3].Value -ne '/') {
            # <PackageReference Include="x"><Version>1.2.3</Version></PackageReference>
            $rest = $Text.Substring($m.Index + $m.Length)
            $close = $rest.IndexOf('</' + $m.Groups[1].Value, [System.StringComparison]::OrdinalIgnoreCase)
            if ($close -gt 0) {
                $cm = [regex]::Match($rest.Substring(0, $close), '<Version>\s*([^<]+?)\s*</Version>', 'IgnoreCase')
                if ($cm.Success) { $ver = $cm.Groups[1].Value }
            }
        }
        $list.Add([pscustomobject]@{ Kind = $m.Groups[1].Value; Name = $name; Version = $ver })
    }
    return ,$list
}

function Get-MsBuildProperty([string]$Text, [string]$Property) {
    $m = [regex]::Match($Text, '<' + $Property + '\b[^>]*>\s*([^<]*?)\s*</' + $Property + '>', 'IgnoreCase')
    if ($m.Success) { return $m.Groups[1].Value }
    return $null
}

function Resolve-ProjectRef([string]$Include, [string]$ProjectDir, [string]$SlnDir) {
    $v = $Include
    $v = $v -replace '\$\(MSBuildThisFileDirectory\)', ($ProjectDir + $script:Sep)
    $v = $v -replace '\$\(MSBuildProjectDirectory\)', $ProjectDir
    $v = $v -replace '\$\(SolutionDir\)', ($SlnDir + $script:Sep)
    if ($v -match '\$\(') { return $null }
    $v = ConvertTo-NativePath $v
    try {
        if ([System.IO.Path]::IsPathRooted($v)) { return [System.IO.Path]::GetFullPath($v) }
        return [System.IO.Path]::GetFullPath((Join-Path $ProjectDir $v))
    } catch { return $null }
}

# Known packages (names are public; reported with versions)
$script:TestPackages = @(
    'xunit', 'xunit.core', 'xunit.v3', 'xunit.v3.core', 'xunit.v3.mtp-v1', 'xunit.v3.mtp-v2', 'xunit.runner.visualstudio',
    'NUnit', 'NUnit3TestAdapter', 'NUnit.Analyzers',
    'MSTest', 'MSTest.TestFramework', 'MSTest.TestAdapter', 'MSTest.Sdk',
    'TUnit', 'Microsoft.NET.Test.Sdk', 'Microsoft.Testing.Platform', 'Microsoft.Testing.Platform.MSBuild'
)
$script:CoveragePackages = @(
    'coverlet.collector', 'coverlet.msbuild', 'coverlet.console', 'coverlet.MTP',
    'Microsoft.CodeCoverage', 'Microsoft.Testing.Extensions.CodeCoverage', 'JetBrains.dotCover.CommandLineTools',
    'ReportGenerator', 'OpenCover', 'altcover'
)
$script:KnownAnalyzers = @(
    'SonarAnalyzer.CSharp', 'StyleCop.Analyzers', 'Roslynator.Analyzers', 'Roslynator.Formatting.Analyzers',
    'Microsoft.CodeAnalysis.NetAnalyzers', 'Microsoft.CodeAnalysis.FxCopAnalyzers', 'Microsoft.VisualStudio.Threading.Analyzers',
    'Meziantou.Analyzer', 'AsyncFixer', 'ErrorProne.NET.CoreAnalyzers', 'SecurityCodeScan.VS2019',
    'Microsoft.CodeAnalysis.BannedApiAnalyzers', 'Microsoft.CodeAnalysis.PublicApiAnalyzers', 'IDisposableAnalyzers',
    'xunit.analyzers', 'NUnit.Analyzers', 'MSTest.Analyzers', 'SerilogAnalyzer', 'Microsoft.EntityFrameworkCore.Analyzers'
)
$script:KnownTools = @(
    'dotnet-sonarscanner', 'dotnet-reportgenerator-globaltool', 'dotnet-coverage', 'coverlet.console', 'dotnet-ef',
    'dotnet-format', 'csharpier', 'dotnet-stryker', 'dotnet-outdated-tool', 'dotnet-affected', 'nbgv', 'gitversion.tool',
    'dotnet-reportgenerator', 'jetbrains.resharper.globaltools', 'husky', 'paket', 'cake.tool', 'nuke.globaltool'
)

function Test-InList([string]$Name, [string[]]$List) {
    foreach ($x in $List) { if ($x -ieq $Name) { return $true } }
    return $false
}

# ---------------------------------------------------------------------------
# TRX and console parsing
# ---------------------------------------------------------------------------

function Read-TrxResults([string]$Dir) {
    $list = New-Object 'System.Collections.Generic.List[object]'
    if (-not (Test-Path -LiteralPath $Dir)) { return ,$list }
    foreach ($f in [System.IO.Directory]::GetFiles($Dir, '*.trx', [System.IO.SearchOption]::AllDirectories)) {
        try {
            $doc = New-Object System.Xml.XmlDocument
            $doc.Load($f)
            $run = $doc.DocumentElement
            $ns = New-Object System.Xml.XmlNamespaceManager($doc.NameTable)
            $ns.AddNamespace('t', $run.NamespaceURI)
            $counters = $run.SelectSingleNode('t:ResultSummary/t:Counters', $ns)
            $times = $run.SelectSingleNode('t:Times', $ns)
            $unit = $run.SelectSingleNode('t:TestDefinitions/t:UnitTest', $ns)
            $assembly = ''
            if ($unit) { $assembly = [System.IO.Path]::GetFileNameWithoutExtension(($unit.GetAttribute('storage') -replace '\\', '/').Split('/')[-1]) }
            $dur = -1
            if ($times) {
                try {
                    $start = [DateTimeOffset]::Parse($times.GetAttribute('start'), [System.Globalization.CultureInfo]::InvariantCulture)
                    $finish = [DateTimeOffset]::Parse($times.GetAttribute('finish'), [System.Globalization.CultureInfo]::InvariantCulture)
                    $dur = ($finish - $start).TotalSeconds
                } catch { $dur = -1 }
            }
            $total = 0; $passed = 0; $failed = 0; $skipped = 0
            $results = $run.SelectNodes('t:Results/t:UnitTestResult', $ns)
            if ($results -and $results.Count -gt 0) {
                # Count outcomes of top-level results (TRX counters do not always include skips).
                foreach ($res in $results) {
                    $total++
                    switch -Regex ($res.GetAttribute('outcome')) {
                        '^Passed'                               { $passed++; break }
                        '^(Failed|Error|Timeout|Aborted)$'      { $failed++; break }
                        default                                 { $skipped++ }
                    }
                }
            } elseif ($counters) {
                $total = [int]$counters.GetAttribute('total')
                $passed = [int]$counters.GetAttribute('passed')
                $failed = [int]$counters.GetAttribute('failed') + [int]('0' + $counters.GetAttribute('error')) + [int]('0' + $counters.GetAttribute('timeout')) + [int]('0' + $counters.GetAttribute('aborted'))
                $skipped = [int]('0' + $counters.GetAttribute('notExecuted')) + [int]('0' + $counters.GetAttribute('inconclusive'))
            }
            $list.Add([pscustomobject]@{ Assembly = $assembly; Total = $total; Passed = $passed; Failed = $failed; Skipped = $skipped; Seconds = $dur })
        } catch {
            Write-Warn ('could not read a TRX file: ' + $_.Exception.Message)
        }
    }
    return ,$list
}

function Read-ConsoleTestSummary([string]$LogPath) {
    # Fallback when no TRX was produced (Microsoft.Testing.Platform mode or the
    # VSTest bridge). Returns @{ Rows; Totals } where Totals may be $null.
    $list = New-Object 'System.Collections.Generic.List[object]'
    $totals = $null
    $text = Read-TextFile $LogPath
    $rx = '(?m)^\s*(?:Passed|Failed)!\s*-\s*Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+),\s*Duration:\s*([^-\r\n]*?)\s*-\s*([^\s(]+)'
    foreach ($m in [regex]::Matches($text, $rx)) {
        $list.Add([pscustomobject]@{
            Assembly = [System.IO.Path]::GetFileNameWithoutExtension($m.Groups[6].Value)
            Total = [int]$m.Groups[4].Value; Passed = [int]$m.Groups[2].Value
            Failed = [int]$m.Groups[1].Value; Skipped = [int]$m.Groups[3].Value
            Seconds = (ConvertFrom-DurationText $m.Groups[5].Value)
        })
    }
    if ($list.Count -eq 0) {
        # Microsoft.Testing.Platform mode: "<path>.dll (net8.0|x64) passed (1s 200ms)" per assembly,
        # then a summary block "total: N / failed: N / succeeded: N / skipped: N / duration: ...".
        $seen = @{}
        $rx = '(?m)^\s*(.+?\.(?:dll|exe))\s+\(([^)]*)\)\s+(passed|failed|skipped|aborted|canceled|cancelled|zero tests ran)\s*\(([^)]+)\)\s*$'
        foreach ($m in [regex]::Matches($text, $rx, 'IgnoreCase')) {
            $asm = [System.IO.Path]::GetFileNameWithoutExtension(($m.Groups[1].Value -replace '\\', '/').Split('/')[-1])
            $key = $asm + '|' + $m.Groups[2].Value
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $list.Add([pscustomobject]@{
                Assembly = $asm; Total = -1; Passed = -1; Failed = -1; Skipped = -1
                Seconds = (ConvertFrom-DurationText $m.Groups[4].Value)
            })
        }
        $m = [regex]::Match($text, '(?is)total:\s*(\d+)\s*,?\s*failed:\s*(\d+)\s*,?\s*succeeded:\s*(\d+)\s*,?\s*skipped:\s*(\d+)\s*,?\s*duration:\s*([^\r\n]+)')
        if ($m.Success) {
            $totals = [pscustomobject]@{
                Total = [int]$m.Groups[1].Value; Passed = [int]$m.Groups[3].Value
                Failed = [int]$m.Groups[2].Value; Skipped = [int]$m.Groups[4].Value
                Seconds = (ConvertFrom-DurationText $m.Groups[5].Value)
            }
        }
    }
    return [pscustomobject]@{ Rows = $list; Totals = $totals }
}

function ConvertFrom-DurationText([string]$Text) {
    $t = $Text.Trim()
    $sec = 0.0; $found = $false
    foreach ($m in [regex]::Matches($t, '([\d.,]+)\s*(ms|h|m|s)\b')) {
        $n = [double]::Parse($m.Groups[1].Value.Replace(',', '.'), [System.Globalization.CultureInfo]::InvariantCulture)
        switch ($m.Groups[2].Value) {
            'ms' { $sec += $n / 1000 }
            's'  { $sec += $n }
            'm'  { $sec += $n * 60 }
            'h'  { $sec += $n * 3600 }
        }
        $found = $true
    }
    if ($found) { return $sec }
    return -1
}

# ---------------------------------------------------------------------------
# CI pipeline hints (tool names only; never URLs, tokens, keys or values)
# ---------------------------------------------------------------------------

$script:CiPatterns = @(
    @{ Rx = 'XPlat Code Coverage';                                  Tool = 'coverlet collector ("XPlat Code Coverage")' },
    @{ Rx = '(?<!XPlat )Code Coverage';                             Tool = 'Microsoft Code Coverage ("Code Coverage" collector)' },
    @{ Rx = 'codeCoverageEnabled\s*:\s*true';                       Tool = 'Microsoft Code Coverage (task codeCoverageEnabled)' },
    @{ Rx = 'CollectCoverage\s*=\s*true';                           Tool = 'coverlet.msbuild (/p:CollectCoverage=true)' },
    @{ Rx = 'coverlet';                                             Tool = 'coverlet (mentioned)' },
    @{ Rx = 'dotnet-coverage';                                      Tool = 'dotnet-coverage tool' },
    @{ Rx = '--coverage\b';                                         Tool = 'Microsoft.Testing.Platform --coverage' },
    @{ Rx = 'dotcover';                                             Tool = 'JetBrains dotCover' },
    @{ Rx = 'opencover';                                            Tool = 'OpenCover format/tool' },
    @{ Rx = 'cobertura';                                            Tool = 'Cobertura format' },
    @{ Rx = 'coveragexml|\.coverage\b';                             Tool = 'VS coverage format (.coverage / coveragexml)' },
    @{ Rx = 'reportgenerator';                                      Tool = 'ReportGenerator' },
    @{ Rx = 'PublishCodeCoverageResults';                           Tool = 'Azure DevOps PublishCodeCoverageResults task' },
    @{ Rx = 'VSTest@\d';                                            Tool = 'Azure DevOps VSTest task' },
    @{ Rx = 'DotNetCoreCLI@\d';                                     Tool = 'Azure DevOps DotNetCoreCLI task' },
    @{ Rx = 'dotnet\s+test';                                        Tool = 'dotnet test' },
    @{ Rx = '--filter|testFilterCriteria';                          Tool = 'a test filter is used (expression not reported)' },
    @{ Rx = '\.runsettings';                                        Tool = 'a .runsettings file is used' },
    @{ Rx = 'SonarQubePrepare@\d|SonarCloudPrepare@\d';             Tool = 'Sonar Azure DevOps Prepare task' },
    @{ Rx = 'scannerMode\s*:\s*[''"]?(MSBuild|dotnet)';             Tool = 'Sonar scannerMode MSBuild/dotnet (= SonarScanner for .NET)' },
    @{ Rx = 'scannerMode\s*:\s*[''"]?CLI';                          Tool = 'Sonar scannerMode CLI (generic scanner)' },
    @{ Rx = 'dotnet-sonarscanner|sonarscanner\s+begin|SonarScanner\.MSBuild'; Tool = 'SonarScanner for .NET' },
    @{ Rx = 'sonarqube-scan-action|sonarcloud-github-action';       Tool = 'Sonar GitHub Action (generic scanner)' },
    @{ Rx = 'sonar-scanner(?!-)';                                   Tool = 'sonar-scanner CLI (mentioned)' },
    @{ Rx = 'withSonarQubeEnv|waitForQualityGate';                  Tool = 'Jenkins SonarQube steps' },
    @{ Rx = 'sonar\.cs\.opencover\.reportsPaths';                   Tool = 'Sonar property sonar.cs.opencover.reportsPaths' },
    @{ Rx = 'sonar\.cs\.vscoveragexml\.reportsPaths';               Tool = 'Sonar property sonar.cs.vscoveragexml.reportsPaths' },
    @{ Rx = 'sonar\.cs\.dotcover\.reportsPaths';                    Tool = 'Sonar property sonar.cs.dotcover.reportsPaths' },
    @{ Rx = 'sonar\.cs\.vstest\.reportsPaths';                      Tool = 'Sonar property sonar.cs.vstest.reportsPaths' },
    @{ Rx = 'sonar\.coverage\.exclusions';                          Tool = 'Sonar property sonar.coverage.exclusions (set in pipeline)' },
    @{ Rx = 'sonar\.qualitygate\.wait';                             Tool = 'Sonar property sonar.qualitygate.wait' }
)

function Get-CiHints([string]$Text) {
    $found = New-Object 'System.Collections.Generic.List[string]'
    foreach ($p in $script:CiPatterns) {
        if ([regex]::IsMatch($Text, $p.Rx, 'IgnoreCase')) { $found.Add($p.Tool) }
    }
    return ,$found
}

function Get-CiKind([string]$Path, [string]$Text) {
    $n = [System.IO.Path]::GetFileName($Path).ToLowerInvariant()
    $norm = $Path.Replace('\', '/').ToLowerInvariant()
    if ($n -like 'jenkinsfile*') { return 'Jenkins' }
    if ($n -eq '.gitlab-ci.yml') { return 'GitLab CI' }
    if ($norm -match '/\.github/workflows/') { return 'GitHub Actions' }
    if ($n -like 'azure-pipelines*') { return 'Azure Pipelines' }
    if ($Text -match '(?m)^\s*-\s*task\s*:') { return 'Azure Pipelines (template)' }
    return 'YAML pipeline'
}

function Test-Recompiled([string]$ObjDir, [string]$AssemblyName, [DateTime]$SinceUtc) {
    # Was the touched project's assembly rewritten after the touch? (obj/<cfg>/<tfm>/<name>.dll)
    if (-not (Test-Path -LiteralPath $ObjDir)) { return $null }
    try {
        foreach ($f in [System.IO.Directory]::GetFiles($ObjDir, ($AssemblyName + '.dll'), [System.IO.SearchOption]::AllDirectories)) {
            if ($f -match '[\\/]ref(int)?[\\/]') { continue }
            if ([System.IO.File]::GetLastWriteTimeUtc($f) -ge $SinceUtc.AddSeconds(-1)) { return $true }
        }
        return $false
    } catch { return $null }
}

function Get-DisplayName($Project) {
    if ($Anonymize) {
        if ($Project.IsTest) { return ($Project.Alias + ' (test)') }
        return $Project.Alias
    }
    return $Project.Name
}

function Add-Pkg([string]$Name, [string]$Version, [string]$Where, [bool]$IsProject) {
    $key = $Name.ToLowerInvariant()
    if (-not $script:PkgAgg.ContainsKey($key)) {
        $script:PkgAgg[$key] = [pscustomobject]@{
            Name = $Name; Projects = 0
            Versions = New-Object 'System.Collections.Generic.List[string]'
            Props = New-Object 'System.Collections.Generic.List[string]'
        }
    }
    $e = $script:PkgAgg[$key]
    if ($Version -and -not $e.Versions.Contains($Version)) { $e.Versions.Add($Version) }
    if ($IsProject) { $e.Projects++ } elseif ($Where -and -not $e.Props.Contains($Where)) { $e.Props.Add($Where) }
}

function Get-PkgLine([string]$Name) {
    $key = $Name.ToLowerInvariant()
    if (-not $script:PkgAgg.ContainsKey($key)) { return $null }
    $e = $script:PkgAgg[$key]
    $ver = '(version not in project files)'
    if ($e.Versions.Count -gt 0) { $ver = ($e.Versions -join ', ') }
    $where = @()
    if ($e.Projects -gt 0) { $where += ('' + $e.Projects + ' project file(s)') }
    if ($e.Props.Count -gt 0) { $where += ($e.Props -join ', ') }
    return ('`' + $e.Name + '` ' + $ver + ' - ' + ($where -join '; '))
}

function Get-StepCell($Step) {
    if ($null -eq $Step) { return 'not run' }
    $s = Format-Duration $Step.Seconds
    if (-not $Step.Ok) { $s += (' (FAILED, exit ' + $Step.ExitCode + ')') }
    return $s
}

function Get-SeriesCell($Series) {
    $arr = @($Series)
    if ($arr.Count -eq 0) { return 'not run' }
    $vals = @(); $failed = 0
    foreach ($x in $arr) { $vals += [double]$x.Seconds; if (-not $x.Ok) { $failed++ } }
    $s = Format-Duration (Get-Median $vals)
    if ($arr.Count -gt 1) {
        $all = @(); foreach ($v in $vals) { $all += (Format-Duration $v) }
        $s = 'median ' + $s + ' (' + ($all -join ', ') + ')'
    }
    if ($failed -gt 0) { $s += (' (' + $failed + ' FAILED)') }
    return $s
}

function Get-YesNo($Value) {
    if ($null -eq $Value) { return 'unknown' }
    if ($Value) { return 'yes' }
    return 'no'
}

# ===========================================================================
# Main
# ===========================================================================

$script:PkgAgg = @{}
$fatal = $false

$script:Steps = New-Object 'System.Collections.Generic.List[object]'
$script:Notes = New-Object 'System.Collections.Generic.List[string]'
$runStart = Get-Date
$stamp = $runStart.ToString('yyyyMMdd-HHmm')
$reportPath = Join-Path (Get-Location).Path ('aftershock-m0-' + $stamp + '.md')
$script:LogDir = Join-Path ([System.IO.Path]::GetTempPath()) ('aftershock-m0-' + $runStart.ToString('yyyyMMdd-HHmmss'))
[void][System.IO.Directory]::CreateDirectory($script:LogDir)
$trxDir = Join-Path $script:LogDir 'trx'

# Environment for child processes: English output (for parsing), no telemetry,
# no workload update checks. Restored at the end.
$envOverrides = [ordered]@{
    'DOTNET_CLI_UI_LANGUAGE'                     = 'en-US'
    'VSLANG'                                     = '1033'
    'DOTNET_NOLOGO'                              = '1'
    'DOTNET_CLI_TELEMETRY_OPTOUT'                = '1'
    'DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE'  = '1'
    'DOTNET_SKIP_FIRST_TIME_EXPERIENCE'          = '1'
}
$savedEnv = @{}
foreach ($k in $envOverrides.Keys) {
    $savedEnv[$k] = [System.Environment]::GetEnvironmentVariable($k, 'Process')
    [System.Environment]::SetEnvironmentVariable($k, $envOverrides[$k], 'Process')
}

$touched = $null   # @{ Path; OriginalUtc }

try {
    Write-Host ('Aftershock M0 measurement v' + $ScriptVersion) -ForegroundColor Green
    Write-Info ('Raw logs: ' + $script:LogDir)

    # --- dotnet ---------------------------------------------------------------
    $cmd = Get-Command dotnet -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { throw 'dotnet was not found on PATH. Install the .NET SDK or open a Developer PowerShell.' }
    $script:DotnetPath = $cmd.Path

    # --- solution ---------------------------------------------------------------
    Write-Step 'Locating solution'
    if (-not $Solution) {
        $cands = @(Get-ChildItem -LiteralPath (Get-Location).Path -File | Where-Object { $_.Extension -ieq '.sln' -or $_.Extension -ieq '.slnx' } | Sort-Object Name)
        if ($cands.Count -eq 0) { throw 'No .sln/.slnx in the current directory. Use -Solution <path>.' }
        $Solution = $cands[0].FullName
        if ($cands.Count -gt 1) { $script:Notes.Add(('Several solutions found in the directory; used the first one (' + $cands.Count + ' candidates).')) }
    }
    if (-not (Test-Path -LiteralPath $Solution)) { throw ('Solution not found: ' + $Solution) }
    $Solution = (Resolve-Path -LiteralPath $Solution).Path
    $slnDir = [System.IO.Path]::GetDirectoryName($Solution)
    $slnName = [System.IO.Path]::GetFileName($Solution)
    Write-Info $slnName

    # Repository root: nearest ancestor with .git (file or folder). Git itself is not run.
    $repoRoot = $slnDir
    $probe = $slnDir
    while ($probe) {
        if (Test-Path -LiteralPath (Join-Path $probe '.git')) { $repoRoot = $probe; break }
        $parent = [System.IO.Path]::GetDirectoryName($probe)
        if (-not $parent -or $parent -eq $probe) { break }
        $probe = $parent
    }

    # --- scan -------------------------------------------------------------------
    Write-Step 'Scanning repository (read-only)'
    $scanSw = [System.Diagnostics.Stopwatch]::StartNew()
    $scan = Invoke-TreeScan $repoRoot
    $slnProjects = Get-SolutionProjects $Solution
    # Projects outside the repo root: count their .cs files separately.
    foreach ($pp in $slnProjects) {
        if (-not (Test-PathUnder $pp $repoRoot)) {
            $extra = Invoke-TreeScan ([System.IO.Path]::GetDirectoryName($pp))
            foreach ($k in $extra.CsCountByDir.Keys) { $scan.CsCountByDir[$k] = $extra.CsCountByDir[$k] }
        }
    }
    $scanSw.Stop()
    Write-Info ('' + $slnProjects.Count + ' projects in solution, ' + $scan.TotalCsFiles + ' .cs files in repo, scan ' + (Format-Duration $scanSw.Elapsed.TotalSeconds))

    # Props files that apply (all Directory.*.props/targets in the repo)
    $propsInfo = New-Object 'System.Collections.Generic.List[object]'
    foreach ($pf in $scan.PropsFiles) {
        $t = Read-TextFile $pf
        $propsInfo.Add([pscustomobject]@{ Path = $pf; Text = $t; Packages = (Get-PackageRefs $t) })
    }

    # Project model
    $projects = New-Object 'System.Collections.Generic.List[object]'
    $byKey = @{}
    $idx = 0
    foreach ($pp in $slnProjects) {
        $idx++
        $exists = Test-Path -LiteralPath $pp
        $text = ''
        if ($exists) { $text = Read-TextFile $pp }
        $pdir = [System.IO.Path]::GetDirectoryName($pp)
        $pkgs = Get-PackageRefs $text
        $sdkAttr = ''
        $sm = [regex]::Match($text, '<Project\s[^>]*Sdk\s*=\s*"([^"]+)"', 'IgnoreCase')
        if ($sm.Success) { $sdkAttr = $sm.Groups[1].Value }
        $isTest = $false; $testReason = ''
        if ((Get-MsBuildProperty $text 'IsTestProject') -ieq 'true') { $isTest = $true; $testReason = 'IsTestProject' }
        elseif ($sdkAttr -match 'MSTest\.Sdk') { $isTest = $true; $testReason = 'MSTest.Sdk' }
        else {
            foreach ($pk in $pkgs) {
                if (Test-InList $pk.Name @('Microsoft.NET.Test.Sdk', 'xunit', 'xunit.v3', 'xunit.core', 'NUnit', 'MSTest', 'MSTest.TestFramework', 'TUnit')) {
                    $isTest = $true; $testReason = 'package ' + $pk.Name; break
                }
            }
        }
        $nameOnly = [System.IO.Path]::GetFileNameWithoutExtension($pp)
        $testName = ($nameOnly -match '(?i)(^|[._])((Unit|Integration|Component|Acceptance|Functional|Api)[._]?)?Tests?$') -or ($nameOnly -cmatch '[a-z0-9]Tests?$')
        if (-not $isTest -and $testName -and $nameOnly -notmatch '(?i)TestData|TestUtil|TestHelper|TestCommon|TestKit|Testing$') {
            $isTest = $true; $testReason = 'name (packages probably come from Directory.Build.props)'
        }
        $refs = New-Object 'System.Collections.Generic.List[string]'
        foreach ($m in [regex]::Matches($text, '<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"', 'IgnoreCase')) {
            foreach ($inc in ($m.Groups[1].Value -split ';')) {
                $r = Resolve-ProjectRef $inc.Trim() $pdir $slnDir
                if ($r) { $refs.Add($r) }
            }
        }
        $csCount = 0
        $dk = Get-PathKey $pdir
        if ($scan.CsCountByDir.ContainsKey($dk)) { $csCount = $scan.CsCountByDir[$dk] }
        $obj = [pscustomobject]@{
            Index = $idx; Path = $pp; Dir = $pdir; Name = $nameOnly; Exists = $exists; Text = $text
            Packages = $pkgs; Sdk = $sdkAttr; IsTest = $isTest; TestReason = $testReason
            Refs = $refs; CsFiles = $csCount; Alias = ('P' + $idx)
            AssemblyName = $nameOnly
        }
        $an = Get-MsBuildProperty $text 'AssemblyName'
        if ($an -and $an -notmatch '\$\(') { $obj.AssemblyName = $an }
        $projects.Add($obj)
        $byKey[(Get-PathKey $pp)] = $obj
    }

    $testProjects = @($projects | Where-Object { $_.IsTest })

    # --- pick the test project ------------------------------------------------------
    $bigTest = $null
    if ($TestProject) {
        $tpCandidate = $null
        if (Test-Path -LiteralPath $TestProject) {
            $k = Get-PathKey (Resolve-Path -LiteralPath $TestProject).Path
            if ($byKey.ContainsKey($k)) { $tpCandidate = $byKey[$k] }
        }
        if (-not $tpCandidate) {
            foreach ($p in $projects) { if ($p.Name -ieq $TestProject -or $p.Name -ieq [System.IO.Path]::GetFileNameWithoutExtension($TestProject)) { $tpCandidate = $p; break } }
        }
        if (-not $tpCandidate) { throw ('Test project not found in the solution: ' + $TestProject) }
        $bigTest = $tpCandidate
    } elseif ($testProjects.Count -gt 0) {
        $bigTest = @($testProjects | Sort-Object -Property @{ Expression = 'CsFiles'; Descending = $true }, @{ Expression = 'Index'; Descending = $false })[0]
    }

    # Transitive closure of the test project (how many projects a test-project build touches)
    $closure = @{}
    $touchProject = $null
    if ($bigTest) {
        $queue = New-Object 'System.Collections.Generic.Queue[string]'
        foreach ($r in $bigTest.Refs) { $queue.Enqueue($r) }
        while ($queue.Count -gt 0) {
            $r = $queue.Dequeue()
            $k = Get-PathKey $r
            if ($closure.ContainsKey($k)) { continue }
            $closure[$k] = $true
            if ($byKey.ContainsKey($k)) { foreach ($rr in $byKey[$k].Refs) { $queue.Enqueue($rr) } }
            else {
                # Referenced but not in the solution: read it anyway to follow the chain.
                if (Test-Path -LiteralPath $r) {
                    $t = Read-TextFile $r
                    foreach ($m in [regex]::Matches($t, '<ProjectReference\b[^>]*\bInclude\s*=\s*"([^"]+)"', 'IgnoreCase')) {
                        $rr = Resolve-ProjectRef $m.Groups[1].Value ([System.IO.Path]::GetDirectoryName($r)) $slnDir
                        if ($rr) { $queue.Enqueue($rr) }
                    }
                }
            }
        }
        # Touch target: direct, non-test project reference with the most .cs files
        $directNonTest = @()
        foreach ($r in $bigTest.Refs) {
            $k = Get-PathKey $r
            if ($byKey.ContainsKey($k) -and -not $byKey[$k].IsTest -and $byKey[$k].CsFiles -gt 0) { $directNonTest += $byKey[$k] }
        }
        if ($directNonTest.Count -gt 0) {
            $touchProject = @($directNonTest | Sort-Object -Property @{ Expression = 'CsFiles'; Descending = $true })[0]
        }
        Write-Info ('Test project for incremental scenarios: ' + (Get-DisplayName $bigTest) + ' (' + $bigTest.CsFiles + ' .cs files, ' + $closure.Count + ' projects in its reference closure)')
    } else {
        $script:Notes.Add('No test project detected; incremental test-project scenarios were skipped.')
        Write-Warn 'No test project detected.'
    }

    # Pick a source file to touch
    $touchFile = $null
    if ($touchProject) {
        $candidates = New-Object 'System.Collections.Generic.List[string]'
        $st = New-Object 'System.Collections.Generic.Stack[string]'
        $st.Push($touchProject.Dir)
        while ($st.Count -gt 0 -and $candidates.Count -lt 200) {
            $d = $st.Pop()
            try {
                foreach ($f in [System.IO.Directory]::GetFiles($d, '*.cs')) {
                    $fn = [System.IO.Path]::GetFileName($f)
                    if ($fn -match '(?i)\.(g|designer|generated|g\.i)\.cs$|^AssemblyInfo\.cs$|^GlobalUsings\.cs$') { continue }
                    $candidates.Add($f)
                }
                foreach ($sd in [System.IO.Directory]::GetDirectories($d)) {
                    $dn = [System.IO.Path]::GetFileName($sd)
                    $skip = $false
                    foreach ($p in $script:PrunedDirs) { if ($dn -ieq $p) { $skip = $true; break } }
                    if (-not $skip) { $st.Push($sd) }
                }
            } catch { }
        }
        if ($candidates.Count -gt 0) {
            $touchFile = @($candidates | Sort-Object)[0]
        }
    }

    # --- environment facts -----------------------------------------------------------
    Write-Step 'Environment'
    $sdkVersion = ''
    Push-Location -LiteralPath $slnDir
    try {
        $r = Invoke-NativeQuiet $script:DotnetPath @('--version')
        if ($r.ExitCode -eq 0 -and $r.Lines.Count -gt 0) { $sdkVersion = ([string]$r.Lines[0]).Trim() } else { $sdkVersion = 'failed (global.json may pin an SDK that is not installed)' }
        $installedSdks = @()
        $r = Invoke-NativeQuiet $script:DotnetPath @('--list-sdks')
        foreach ($l in $r.Lines) { $mm = [regex]::Match([string]$l, '^\s*(\S+)'); if ($mm.Success) { $installedSdks += $mm.Groups[1].Value } }
        $nugetEnabled = -1; $nugetOrg = 'unknown'
        $r = Invoke-NativeQuiet $script:DotnetPath @('nuget', 'list', 'source', '--format', 'short')
        if ($r.ExitCode -eq 0) {
            $nugetEnabled = 0; $nugetOrg = 'no'
            foreach ($l in $r.Lines) {
                $s = [string]$l
                if ($s -match '^\s*E\w*\s+\S') {
                    $nugetEnabled++
                    if ($s -match 'api\.nuget\.org') { $nugetOrg = 'yes' }
                }
            }
        }
    } finally {
        Pop-Location
    }

    $osText = [System.Environment]::OSVersion.VersionString
    if (-not $script:OnWindows) {
        # PowerShell 7 only (RuntimeInformation is not loaded by default in Windows PowerShell 5.1).
        try { $osText = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription } catch { $osText = [System.Environment]::OSVersion.VersionString }
    }
    if ($script:OnWindows) {
        try {
            $cv = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction Stop
            $extraOs = @()
            if ($cv.EditionID) { $extraOs += [string]$cv.EditionID }
            if ($cv.DisplayVersion) { $extraOs += [string]$cv.DisplayVersion } elseif ($cv.ReleaseId) { $extraOs += [string]$cv.ReleaseId }
            if ($cv.CurrentBuild) { $b = [int]$cv.CurrentBuild; if ($b -ge 22000) { $extraOs += 'Windows 11 family' } else { $extraOs += 'Windows 10 family' } }
            if ($extraOs.Count -gt 0) { $osText = $osText + ' (' + ($extraOs -join ', ') + ')' }
        } catch { }
    }
    $memGb = ''
    try {
        if ($script:OnWindows) {
            $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
            $memGb = '{0:0.0} GB' -f ($cs.TotalPhysicalMemory / 1GB)
        } elseif (Test-Path -LiteralPath '/proc/meminfo') {
            $mm = [regex]::Match((Read-TextFile '/proc/meminfo'), 'MemTotal:\s+(\d+)\s*kB')
            if ($mm.Success) { $memGb = '{0:0.0} GB' -f ([double]$mm.Groups[1].Value / 1MB) }
        }
    } catch { $memGb = 'unknown' }
    $proxySet = 'no'
    foreach ($pv in @('HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'ALL_PROXY')) {
        if ([System.Environment]::GetEnvironmentVariable($pv)) { $proxySet = 'yes'; break }
    }
    $systemProxy = ''
    if ($script:OnWindows) {
        # Presence only (registry read, no network, no values reported).
        try {
            $is = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
            $kinds = @()
            if ($is.ProxyEnable -eq 1) { $kinds += 'manual proxy' }
            if ($is.AutoConfigURL) { $kinds += 'PAC script' }
            if ($kinds.Count -eq 0) { $systemProxy = 'none' } else { $systemProxy = ($kinds -join ' + ') }
        } catch { $systemProxy = 'unknown' }
    }
    Write-Info ('SDK ' + $sdkVersion + ' | ' + $osText + ' | ' + [System.Environment]::ProcessorCount + ' logical CPUs')

    # --- package / framework detection -------------------------------------------------
    foreach ($p in $projects) {
        foreach ($pk in $p.Packages) { Add-Pkg $pk.Name $pk.Version '' $true }
        if ($p.Sdk -match 'MSTest\.Sdk') { $v = ''; if ($p.Sdk -match '/(.+)$') { $v = $Matches[1] }; Add-Pkg 'MSTest.Sdk' $v '' $true }
    }
    foreach ($pi in $propsInfo) {
        $where = [System.IO.Path]::GetFileName($pi.Path)
        foreach ($pk in $pi.Packages) {
            $label = $where
            if ($pk.Kind -ieq 'PackageVersion') { $label = $where + ' (central version)' }
            Add-Pkg $pk.Name $pk.Version $label $false
        }
    }

    # Microsoft.Testing.Platform indicators
    $mtp = New-Object 'System.Collections.Generic.List[string]'
    $mtpProps = @('UseMicrosoftTestingPlatformRunner', 'TestingPlatformDotnetTestSupport', 'EnableMSTestRunner', 'EnableNUnitRunner', 'TestingPlatformShowTestsFailure', 'TestingPlatformCaptureOutput')
    $allBuildTexts = @()
    foreach ($p in $projects) { $allBuildTexts += [pscustomobject]@{ Where = 'project'; Text = $p.Text } }
    foreach ($pi in $propsInfo) { $allBuildTexts += [pscustomobject]@{ Where = [System.IO.Path]::GetFileName($pi.Path); Text = $pi.Text } }
    foreach ($prop in $mtpProps) {
        $vals = @{}; $cnt = 0
        foreach ($bt in $allBuildTexts) {
            foreach ($m in [regex]::Matches($bt.Text, '<' + $prop + '\b[^>]*>\s*([^<]*?)\s*</' + $prop + '>', 'IgnoreCase')) {
                $cnt++; $vals[$m.Groups[1].Value.ToLowerInvariant()] = $true
            }
        }
        if ($cnt -gt 0) { $mtp.Add(('`' + $prop + '` = ' + (($vals.Keys | Sort-Object) -join '/') + ' (' + $cnt + ' occurrence(s))')) }
    }
    $xunitV3Exe = 0
    foreach ($p in $projects) {
        $isV3 = $false
        foreach ($pk in $p.Packages) { if ($pk.Name -like 'xunit.v3*') { $isV3 = $true } }
        if ($isV3 -and (Get-MsBuildProperty $p.Text 'OutputType') -ieq 'Exe') { $xunitV3Exe++ }
    }
    $testRunnerMode = 'vstest'
    $probe = $slnDir
    while ($probe) {
        $gjPath = Join-Path $probe 'global.json'
        if (Test-Path -LiteralPath $gjPath) {
            if ((Read-TextFile $gjPath) -match '"test"\s*:\s*\{[^}]*"runner"\s*:\s*"Microsoft\.Testing\.Platform"') { $testRunnerMode = 'mtp' }
            break
        }
        $parent = [System.IO.Path]::GetDirectoryName($probe)
        if (-not $parent -or $parent -eq $probe) { break }
        $probe = $parent
    }
    $globalJsonInfo = @()
    foreach ($of in $scan.OtherFiles) {
        if ([System.IO.Path]::GetFileName($of) -ieq 'global.json') {
            $gj = Read-TextFile $of
            if ($Anonymize) { $line = 'global.json #' + ($globalJsonInfo.Count + 1) }
            else { $line = 'global.json at `' + (Get-RelativePathSafe ([System.IO.Path]::GetDirectoryName($of)) $repoRoot) + '`' }
            $vm = [regex]::Match($gj, '"version"\s*:\s*"([^"]+)"')
            if ($vm.Success) { $line += ': sdk ' + $vm.Groups[1].Value }
            $rm = [regex]::Match($gj, '"rollForward"\s*:\s*"([^"]+)"')
            if ($rm.Success) { $line += ', rollForward ' + $rm.Groups[1].Value }
            $tm = [regex]::Match($gj, '"test"\s*:\s*\{[^}]*"runner"\s*:\s*"([^"]+)"')
            if ($tm.Success) {
                $line += ', test runner ' + $tm.Groups[1].Value
                $mtp.Add(('global.json "test": { "runner": "' + $tm.Groups[1].Value + '" }'))
            }
            if ($gj -match '"msbuild-sdks"') { $line += ', msbuild-sdks pinned' }
            $globalJsonInfo += $line
        }
    }

    # Build-affecting properties seen in project/props files (values only for known flags)
    $buildFlags = New-Object 'System.Collections.Generic.List[string]'
    foreach ($prop in @('TreatWarningsAsErrors', 'RunAnalyzers', 'RunAnalyzersDuringBuild', 'EnforceCodeStyleInBuild', 'AnalysisLevel', 'AnalysisMode', 'EnableNETAnalyzers', 'GenerateDocumentationFile', 'Deterministic', 'ProduceReferenceAssembly', 'UseArtifactsOutput', 'ManagePackageVersionsCentrally', 'RestorePackagesWithLockFile', 'Nullable', 'LangVersion', 'TargetFrameworks')) {
        $vals = @{}; $cnt = 0
        foreach ($bt in $allBuildTexts) {
            foreach ($m in [regex]::Matches($bt.Text, '<' + $prop + '\b[^>]*>\s*([^<]*?)\s*</' + $prop + '>', 'IgnoreCase')) {
                $cnt++
                $v = $m.Groups[1].Value
                if ($v.Length -gt 40) { $v = $v.Substring(0, 40) + '...' }
                $vals[$v] = $true
            }
        }
        if ($cnt -gt 0) { $buildFlags.Add(('`' + $prop + '` = ' + (($vals.Keys | Sort-Object) -join ' / ') + ' (' + $cnt + 'x)')) }
    }
    $tfms = @{}
    foreach ($p in $projects) {
        $tf = Get-MsBuildProperty $p.Text 'TargetFramework'
        if (-not $tf) { $tf = Get-MsBuildProperty $p.Text 'TargetFrameworks' }
        if (-not $tf) { $tf = '(from props)' }
        foreach ($x in ($tf -split ';')) { if ($x) { if ($tfms.ContainsKey($x)) { $tfms[$x]++ } else { $tfms[$x] = 1 } } }
    }

    # CI files
    $ciFiles = New-Object 'System.Collections.Generic.List[string]'
    foreach ($f in $scan.CiFiles) { $ciFiles.Add($f) }
    foreach ($f in $scan.YamlFiles) {
        $norm = $f.Replace('\', '/')
        if ($norm -match '/\.github/workflows/[^/]+$') { $ciFiles.Add($f); continue }
        $t = Read-TextFile $f
        if ($t -match '(?m)^\s*-\s*task\s*:' -or ($t -match '(?m)^\s*(stages|jobs)\s*:' -and $t -match '(?m)^\s*(-\s*)?(steps|script)\s*:')) { $ciFiles.Add($f) }
    }
    $ciInfo = New-Object 'System.Collections.Generic.List[object]'
    $ciN = 0
    foreach ($f in $ciFiles) {
        $ciN++
        $t = Read-TextFile $f
        $ciInfo.Add([pscustomobject]@{ Path = $f; Kind = (Get-CiKind $f $t); Hints = (Get-CiHints $t); N = $ciN })
    }
    $runSettingsInfo = New-Object 'System.Collections.Generic.List[object]'
    foreach ($rs in $scan.RunSettings) {
        $t = Read-TextFile $rs
        $collectors = @()
        foreach ($m in [regex]::Matches($t, 'friendlyName\s*=\s*"([^"]+)"', 'IgnoreCase')) { $collectors += $m.Groups[1].Value }
        $formats = @()
        foreach ($m in [regex]::Matches($t, '<Format>\s*([^<]+?)\s*</Format>', 'IgnoreCase')) { $formats += $m.Groups[1].Value }
        $runSettingsInfo.Add([pscustomobject]@{ Path = $rs; Collectors = ($collectors | Select-Object -Unique); Formats = ($formats | Select-Object -Unique) })
    }
    $otherFacts = New-Object 'System.Collections.Generic.List[string]'
    foreach ($of in $scan.OtherFiles) {
        $n = [System.IO.Path]::GetFileName($of).ToLowerInvariant()
        if ($n -eq 'sonar-project.properties') { $otherFacts.Add('`sonar-project.properties` present (values not read)') }
        if ($n -eq 'sonarqube.analysis.xml') { $otherFacts.Add('`SonarQube.Analysis.xml` present (values not read)') }
        if ($n -eq 'dotnet-tools.json') {
            $t = Read-TextFile $of
            $known = @(); $unknown = 0
            foreach ($m in [regex]::Matches($t, '"([A-Za-z0-9_.\-]+)"\s*:\s*\{\s*"version"')) {
                $tn = $m.Groups[1].Value
                if ((Test-InList $tn $script:KnownTools) -or -not $Anonymize) { $known += $tn } else { $unknown++ }
            }
            $line = 'Local dotnet tools: ' + ($known -join ', ')
            if ($unknown -gt 0) { $line += (' (+' + $unknown + ' other)') }
            $otherFacts.Add($line)
        }
    }
    foreach ($bt in $allBuildTexts) {
        if ($bt.Text -match 'SonarQubeExclude|SonarQubeTestProject|SonarQubeSetting') { $otherFacts.Add('Sonar MSBuild properties (SonarQubeExclude / SonarQubeTestProject / SonarQubeSetting) used in build files (SonarScanner for .NET)'); break }
    }
    $runSettingsProp = $false
    foreach ($bt in $allBuildTexts) { if ($bt.Text -match '<RunSettingsFilePath\b') { $runSettingsProp = $true; break } }

    # =================================================================================
    # Measurements
    # =================================================================================
    $restore = $null; $build = $null; $test = $null
    $buildFailed = $false

    if (-not $SkipRestore) {
        Write-Step 'Step 1/4: dotnet restore'
        $restore = Invoke-Dotnet -Name 'restore' -Arguments @('restore', $Solution) -WorkingDirectory $slnDir
        if (-not $restore.Ok) { Write-Warn 'restore failed; continuing, but the build will probably fail too.' }
    } else {
        Write-Step 'Step 1/4: dotnet restore (skipped, -SkipRestore)'
    }

    Write-Step 'Step 2/4: full rebuild of the solution (dotnet build --no-restore --no-incremental)'
    $build = Invoke-Dotnet -Name 'build-solution' -Arguments @('build', $Solution, '--no-restore', '--no-incremental', '-c', $Configuration) -WorkingDirectory $slnDir
    if (-not $build.Ok) {
        $buildFailed = $true
        Write-Warn 'solution build failed; test and incremental steps are skipped.'
        $script:Notes.Add('The solution build failed, so the test run and incremental scenarios were skipped. Check the local build log.')
    }

    $trx = $null; $consoleSummary = $null
    if (-not $buildFailed) {
        Write-Step 'Step 3/4: dotnet test --no-build (whole solution)'
        if ($testRunnerMode -eq 'mtp') {
            # .NET 10+ Microsoft.Testing.Platform mode: --solution is required, no VSTest loggers.
            $targs = @('test', '--solution', $Solution, '--no-build', '-c', $Configuration)
            Write-Info 'global.json selects Microsoft.Testing.Platform: using `dotnet test --solution`, results parsed from the console.'
            if ($TestFilter) { Write-Warn '--filter is not understood by every framework in MTP mode (xUnit v3 rejects it); use -ExtraTestArgs if the run fails.' }
        } else {
            $targs = @('test', $Solution, '--no-build', '-c', $Configuration, '--logger', 'trx', '--results-directory', $trxDir)
        }
        if ($TestFilter) { $targs += @('--filter', $TestFilter) }
        if ($ExtraTestArgs) { $targs += @($ExtraTestArgs -split '\s+' | Where-Object { $_ -ne '' }) }
        $test = Invoke-Dotnet -Name 'test-solution' -Arguments $targs -WorkingDirectory $slnDir
        $trx = Read-TrxResults $trxDir
        $consoleSummary = Read-ConsoleTestSummary $test.OutLog
        if (-not $test.Ok) { $script:Notes.Add(('`dotnet test` exited with code ' + $test.ExitCode + ' (failing tests, or a test host problem; ' + $test.ErrorHint + ').')) }
    }

    # Incremental scenarios on the big test project
    $incA = @(); $incB = @(); $incC = @(); $warm1 = $null; $warmC = $null
    $recompiledB = $null; $recompiledC = $null
    if (-not $buildFailed -and $bigTest) {
        Write-Step ('Step 4/4: incremental builds of the largest test project (' + (Get-DisplayName $bigTest) + ')')
        $baseArgs = @('build', $bigTest.Path, '--no-restore', '-c', $Configuration)
        $fastArgs = $baseArgs + @('-p:RunAnalyzers=false', '-p:TreatWarningsAsErrors=false')

        Write-Info 'warm-up: first build of the test project alone (not used in conclusions)'
        $warm1 = Invoke-Dotnet -Name 'testproj-warmup' -Arguments $baseArgs -WorkingDirectory $slnDir
        $runs = $Repeat
        if (-not $warm1.Ok) {
            Write-Warn 'building the test project alone failed; incremental scenarios are skipped.'
            $script:Notes.Add('Building the test project on its own failed, so scenarios 4a-4c were skipped (it may depend on solution-level properties).')
            $touchFile = $null
            $runs = 0
        }

        for ($i = 1; $i -le $runs; $i++) {
            Write-Info ('(a) no-op incremental build, run ' + $i + '/' + $runs)
            $incA += Invoke-Dotnet -Name ('testproj-a-noop-' + $i) -Arguments $baseArgs -WorkingDirectory $slnDir
        }

        if ($touchFile) {
            $fi = New-Object System.IO.FileInfo($touchFile)
            $touched = @{ Path = $touchFile; OriginalUtc = $fi.LastWriteTimeUtc }
            $objDir = Join-Path $touchProject.Dir 'obj'

            for ($i = 1; $i -le $runs; $i++) {
                Write-Info ('(b) touch 1 source file, incremental build, run ' + $i + '/' + $runs)
                $t0 = [DateTime]::UtcNow
                [System.IO.File]::SetLastWriteTimeUtc($touchFile, $t0)
                $r = Invoke-Dotnet -Name ('testproj-b-touch-' + $i) -Arguments $baseArgs -WorkingDirectory $slnDir
                $incB += $r
                if ($null -eq $recompiledB) { $recompiledB = Test-Recompiled $objDir $touchProject.AssemblyName $t0 }
            }

            Write-Info 'warm-up: no-op build with analyzers off (primes caches for (c); also reported)'
            $warmC = Invoke-Dotnet -Name 'testproj-c-warmup-noop' -Arguments $fastArgs -WorkingDirectory $slnDir

            for ($i = 1; $i -le $runs; $i++) {
                Write-Info ('(c) touch 1 source file, incremental build with analyzers off, run ' + $i + '/' + $runs)
                $t0 = [DateTime]::UtcNow
                [System.IO.File]::SetLastWriteTimeUtc($touchFile, $t0)
                $r = Invoke-Dotnet -Name ('testproj-c-touch-fast-' + $i) -Arguments $fastArgs -WorkingDirectory $slnDir
                $incC += $r
                if ($null -eq $recompiledC) { $recompiledC = Test-Recompiled $objDir $touchProject.AssemblyName $t0 }
            }
        } elseif ($runs -gt 0) {
            $script:Notes.Add('No suitable source file in a referenced non-test project was found; scenarios (b) and (c) were skipped.')
        }
    }
}
catch {
    Write-Host ''
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    $script:Notes.Add(('Script error: ' + $_.Exception.Message))
    $fatal = $true
}
finally {
    if ($touched) {
        try {
            [System.IO.File]::SetLastWriteTimeUtc($touched.Path, $touched.OriginalUtc)
            Write-Info 'Restored the original last-write time of the touched file.'
        } catch {
            Write-Warn ('Could not restore the last-write time of ' + $touched.Path + ': ' + $_.Exception.Message)
        }
    }
    foreach ($k in $savedEnv.Keys) { [System.Environment]::SetEnvironmentVariable($k, $savedEnv[$k], 'Process') }
}


# ===========================================================================
# Report
# ===========================================================================

if (-not $slnName) {
    # Nothing was measured (no solution); do not leave an empty report behind.
    exit 1
}

$R = New-Object 'System.Collections.Generic.List[string]'
$totalSeconds = ((Get-Date) - $runStart).TotalSeconds
$slnLabel = $slnName
if ($Anonymize -and $slnName) { $slnLabel = 'S1' + [System.IO.Path]::GetExtension($slnName) }

$R.Add('# Aftershock M0 measurement report')
$R.Add('')
$R.Add(('- Generated: ' + $runStart.ToString('yyyy-MM-dd HH:mm') + ' (local time), script ' + $ScriptVersion + ', total script time ' + (Format-Duration $totalSeconds)))
$R.Add(('- Solution: `' + $slnLabel + '`, configuration `' + $Configuration + '`, anonymized: ' + (Get-YesNo ([bool]$Anonymize))))
if ($TestFilter) {
    if ($Anonymize) { $R.Add('- Test filter for the solution test run: set (expression hidden)') }
    else { $R.Add(('- Test filter for the solution test run: `' + $TestFilter + '`')) }
}
if ($ExtraTestArgs) { $R.Add('- Extra `dotnet test` arguments: set (hidden)') }
if ($Repeat -gt 1) { $R.Add(('- Incremental scenarios repeated ' + $Repeat + ' times (median shown)')) }
$R.Add('')

# --- conclusion -------------------------------------------------------------------
$R.Add('## Conclusion')
$R.Add('')
if ($build -and $build.Ok -and $test) {
    $b = $build.Seconds; $t = $test.Seconds
    $sum = $b + $t
    $bp = [int][Math]::Round(100.0 * $b / $sum)
    $tp = 100 - $bp
    $line = ('**Build ' + $bp + '% vs tests ' + $tp + '%** of a full rebuild + full test run (rebuild ' + (Format-Duration $b) + ', tests ' + (Format-Duration $t))
    if ($restore) { $line += (', restore ' + (Format-Duration $restore.Seconds) + ' not counted') }
    $line += ').'
    $R.Add($line)
    $R.Add('')
    if ($bp -ge 60) { $R.Add('Build time dominates: making the build cheaper (build only the needed test project, analyzers off, avoid restore) matters at least as much as test selection.') }
    elseif ($tp -ge 60) { $R.Add('Test time dominates: running only the impacted test methods gives the biggest win.') }
    else { $R.Add('Build and tests are of similar size: both build trimming and test selection matter.') }
    $incBMed = -1; $incCMed = -1
    if (@($incB).Count -gt 0) { $vals = @(); foreach ($x in $incB) { $vals += [double]$x.Seconds }; $incBMed = Get-Median $vals }
    if (@($incC).Count -gt 0) { $vals = @(); foreach ($x in $incC) { $vals += [double]$x.Seconds }; $incCMed = Get-Median $vals }
    if ($incBMed -ge 0) {
        $R.Add('')
        $line = ('Inner loop (Aftershock scenario): after a one-file change in a referenced project, building the largest test project takes **' + (Format-Duration $incBMed) + '**')
        if ($incCMed -ge 0 -and $incBMed -gt 0) {
            $gain = [int][Math]::Round(100.0 * ($incBMed - $incCMed) / $incBMed)
            if ($gain -ge 0) { $gainText = ('' + $gain + '% less') } else { $gainText = ('' + (-$gain) + '% more') }
            $line += (' (' + (Format-Duration $incCMed) + ' with analyzers off, ' + $gainText + ')')
        }
        $line += '.'
        $R.Add($line)
    }
} else {
    $R.Add('Not enough data for a conclusion (the build or the test run did not complete). See Notes.')
}
$R.Add('')

# --- timings ------------------------------------------------------------------------
$R.Add('## Timings (wall clock)')
$R.Add('')
$R.Add('| # | Step | Command | Time |')
$R.Add('|---|---|---|---|')
$restoreCell = 'skipped (-SkipRestore)'
if (-not $SkipRestore) { $restoreCell = Get-StepCell $restore }
$R.Add(('| 1 | Restore | `dotnet restore` | ' + $restoreCell + ' |'))
$R.Add(('| 2 | Full rebuild, whole solution | `dotnet build --no-restore --no-incremental` | ' + (Get-StepCell $build) + ' |'))
$R.Add(('| 3 | All tests, whole solution | `dotnet test --no-build` | ' + (Get-StepCell $test) + ' |'))
$R.Add(('| 4 | Largest test project alone, first build after step 2 (warm-up) | `dotnet build <test.csproj> --no-restore` | ' + (Get-StepCell $warm1) + ' |'))
$R.Add(('| 4a | ... no-op incremental build | same | ' + (Get-SeriesCell $incA) + ' |'))
$R.Add(('| 4b | ... after touching 1 source file in a referenced project | same | ' + (Get-SeriesCell $incB) + ' |'))
$R.Add(('| 4c | ... same as 4b, analyzers off | `+ -p:RunAnalyzers=false -p:TreatWarningsAsErrors=false` | ' + (Get-SeriesCell $incC) + ' |'))
$R.Add(('| 4c0 | ... no-op with analyzers off (warm-up for 4c) | same as 4c | ' + (Get-StepCell $warmC) + ' |'))
$R.Add('')
if ($bigTest) {
    $R.Add(('- Largest test project: ' + (Get-DisplayName $bigTest) + ', ' + $bigTest.CsFiles + ' .cs files, ' + $closure.Count + ' project(s) in its reference closure'))
}
if ($touchProject) {
    $tfLabel = 'a source file'
    if (-not $Anonymize -and $touchFile) { $tfLabel = '`' + (Get-RelativePathSafe $touchFile $repoRoot) + '`' }
    $R.Add(('- Touched (mtime only, restored afterwards): ' + $tfLabel + ' in ' + (Get-DisplayName $touchProject) + ' (' + $touchProject.CsFiles + ' .cs files; direct reference of the test project)'))
    $R.Add(('- Touched project recompiled in 4b: ' + (Get-YesNo $recompiledB) + ', in 4c: ' + (Get-YesNo $recompiledC)))
}
$R.Add('')

# --- test results -------------------------------------------------------------------
$R.Add('## Test results (whole solution)')
$R.Add('')
$rows = $null; $source = ''; $totalsRow = $null
if ($trx -and $trx.Count -gt 0) { $rows = $trx; $source = 'TRX files' }
elseif ($consoleSummary -and ($consoleSummary.Rows.Count -gt 0 -or $consoleSummary.Totals)) {
    $rows = $consoleSummary.Rows; $totalsRow = $consoleSummary.Totals; $source = 'console output'
}
if ($rows -or $totalsRow) {
    $asmMap = @{}
    if ($projects) { foreach ($p in $projects) { $asmMap[$p.AssemblyName.ToLowerInvariant()] = $p } }
    $tt = 0; $tp2 = 0; $tf = 0; $ts = 0; $unk = 0
    $R.Add('| Test assembly | Total | Passed | Failed | Skipped | Duration |')
    $R.Add('|---|---:|---:|---:|---:|---:|')
    foreach ($row in ($rows | Sort-Object -Property Seconds -Descending)) {
        $label = $row.Assembly
        $k = ([string]$row.Assembly).ToLowerInvariant()
        if ($asmMap.ContainsKey($k)) { $label = Get-DisplayName $asmMap[$k] }
        elseif ($Anonymize -and $row.Assembly -ne '(all)') { $unk++; $label = 'A' + $unk }
        $cells = @()
        foreach ($v in @($row.Total, $row.Passed, $row.Failed, $row.Skipped)) { if ($v -lt 0) { $cells += '?' } else { $cells += ('' + $v) } }
        $R.Add(('| ' + $label + ' | ' + ($cells -join ' | ') + ' | ' + (Format-Duration $row.Seconds) + ' |'))
        $tt += $row.Total; $tp2 += $row.Passed; $tf += $row.Failed; $ts += $row.Skipped
    }
    if ($totalsRow) { $tt = $totalsRow.Total; $tp2 = $totalsRow.Passed; $tf = $totalsRow.Failed; $ts = $totalsRow.Skipped }
    $R.Add(('| **All** | **' + $tt + '** | **' + $tp2 + '** | **' + $tf + '** | **' + $ts + '** | ' + (Format-Duration $test.Seconds) + ' wall |'))
    $R.Add('')
    $R.Add(('Source: ' + $source + '. Test projects run in parallel, so per-assembly durations overlap and do not add up to the wall-clock time.'))
} else {
    $R.Add('No test results could be read (no TRX and no recognizable console summary).')
}
$R.Add('')

# --- environment ---------------------------------------------------------------------
$R.Add('## Environment')
$R.Add('')
$R.Add(('- .NET SDK used (resolved in the solution folder): ' + $sdkVersion))
if ($installedSdks.Count -gt 0) { $R.Add(('- Installed SDKs: ' + ($installedSdks -join ', '))) }
foreach ($g in $globalJsonInfo) { $R.Add(('- ' + $g)) }
$R.Add(('- OS: ' + $osText))
$R.Add(('- PowerShell: ' + $PSVersionTable.PSVersion.ToString() + ' (' + $PSVersionTable.PSEdition + ')'))
$R.Add(('- Logical CPUs: ' + [System.Environment]::ProcessorCount))
if ($memGb) { $R.Add(('- Memory: ' + $memGb)) }
$R.Add(('- Proxy environment variable set: ' + $proxySet))
if ($systemProxy) { $R.Add(('- Windows system proxy: ' + $systemProxy)) }
if ($nugetEnabled -ge 0) { $R.Add(('- NuGet sources enabled: ' + $nugetEnabled + ', nuget.org among them: ' + $nugetOrg)) }
$R.Add('')

# --- solution shape -------------------------------------------------------------------
$R.Add('## Solution shape')
$R.Add('')
if ($projects) {
    $csproj = @($projects | Where-Object { $_.Path -match '\.csproj$' }).Count
    $R.Add(('- Projects in solution: ' + $projects.Count + ' (C#: ' + $csproj + '), test projects: ' + $testProjects.Count))
    $R.Add(('- .cs files in the repository (excluding bin/obj): ' + $scan.TotalCsFiles))
    $tfmParts = @()
    foreach ($k in ($tfms.Keys | Sort-Object)) { $tfmParts += ($k + ' (' + $tfms[$k] + ')') }
    if ($tfmParts.Count -gt 0) { $R.Add(('- Target frameworks: ' + ($tfmParts -join ', '))) }
    $R.Add('')
    if ($testProjects.Count -gt 0) {
        $R.Add('| Test project | .cs files | Detected by | Frameworks |')
        $R.Add('|---|---:|---|---|')
        foreach ($p in ($testProjects | Sort-Object -Property CsFiles -Descending)) {
            $fw = @()
            foreach ($pk in $p.Packages) {
                if ($pk.Name -ieq 'xunit' -or $pk.Name -ieq 'xunit.core') { $fw += 'xUnit v2' }
                elseif ($pk.Name -like 'xunit.v3*') { $fw += 'xUnit v3' }
                elseif ($pk.Name -ieq 'NUnit') { $fw += 'NUnit' }
                elseif ($pk.Name -ieq 'MSTest' -or $pk.Name -ieq 'MSTest.TestFramework') { $fw += 'MSTest' }
                elseif ($pk.Name -ieq 'TUnit') { $fw += 'TUnit' }
            }
            if ($p.Sdk -match 'MSTest\.Sdk') { $fw += 'MSTest (MSTest.Sdk)' }
            $fwText = ($fw | Select-Object -Unique) -join ', '
            if (-not $fwText) { $fwText = '(from props)' }
            $reason = $p.TestReason
            if ($reason -like 'package *' -and $Anonymize) { $reason = 'test packages' }
            $R.Add(('| ' + (Get-DisplayName $p) + ' | ' + $p.CsFiles + ' | ' + $reason + ' | ' + $fwText + ' |'))
        }
        $R.Add('')
    }
}

# --- test frameworks ---------------------------------------------------------------------
$R.Add('## Test frameworks and runner')
$R.Add('')
$hasV2 = $script:PkgAgg.ContainsKey('xunit') -or $script:PkgAgg.ContainsKey('xunit.core')
$hasV3 = $false
foreach ($k in $script:PkgAgg.Keys) { if ($k -like 'xunit.v3*') { $hasV3 = $true } }
$flavor = 'not used'
if ($hasV2 -and $hasV3) { $flavor = 'both v2 (`xunit`) and v3 (`xunit.v3`)' }
elseif ($hasV2) { $flavor = 'v2 (`xunit`)' }
elseif ($hasV3) { $flavor = 'v3 (`xunit.v3`)' }
$modeText = 'VSTest (default)'
if ($testRunnerMode -eq 'mtp') { $modeText = 'Microsoft.Testing.Platform (selected in global.json)' }
$R.Add(('- `dotnet test` mode for this solution: ' + $modeText))
$R.Add(('- xUnit flavor: ' + $flavor))
if ($hasV3) { $R.Add(('- xunit.v3 projects with `<OutputType>Exe</OutputType>` in the project file: ' + $xunitV3Exe)) }
$anyTestPkg = $false
foreach ($n in $script:TestPackages) {
    $l = Get-PkgLine $n
    if ($l) { $R.Add(('- ' + $l)); $anyTestPkg = $true }
}
if (-not $anyTestPkg) { $R.Add('- No known test framework package references found in project or props files.') }
if ($mtp.Count -gt 0) {
    $R.Add('- Microsoft.Testing.Platform indicators:')
    foreach ($m in $mtp) { $R.Add(('  - ' + $m)) }
} else {
    $R.Add('- Microsoft.Testing.Platform indicators: none found (`dotnet test` runs in VSTest mode)')
}
$R.Add('')

# --- coverage --------------------------------------------------------------------------------
$R.Add('## Coverage tooling')
$R.Add('')
$anyCov = $false
foreach ($n in $script:CoveragePackages) {
    $l = Get-PkgLine $n
    if ($l) { $R.Add(('- ' + $l)); $anyCov = $true }
}
if (-not $anyCov) { $R.Add('- No coverage packages referenced in project or props files.') }
if ($script:PkgAgg.ContainsKey('microsoft.net.test.sdk')) { $R.Add('- Note: `Microsoft.NET.Test.Sdk` brings `Microsoft.CodeCoverage` transitively, so the "Code Coverage" collector is available even without an explicit reference.') }
if ($runSettingsInfo.Count -gt 0) {
    $i = 0
    foreach ($rs in $runSettingsInfo) {
        $i++
        $label = 'runsettings #' + $i
        if (-not $Anonymize) { $label = '`' + (Get-RelativePathSafe $rs.Path $repoRoot) + '`' }
        $c = '(none)'; if ($rs.Collectors) { $c = (@($rs.Collectors) -join ', ') }
        $f = '(default)'; if ($rs.Formats) { $f = (@($rs.Formats) -join ', ') }
        $R.Add(('- ' + $label + ': data collectors ' + $c + '; formats ' + $f))
    }
}
$R.Add(('- `RunSettingsFilePath` set in build files: ' + (Get-YesNo $runSettingsProp)))
$R.Add('')

# --- analyzers and build flags -------------------------------------------------------------------
$R.Add('## Analyzers and build flags')
$R.Add('')
$anyAn = $false; $otherAn = @()
foreach ($k in ($script:PkgAgg.Keys | Sort-Object)) {
    $e = $script:PkgAgg[$k]
    if (Test-InList $e.Name $script:KnownAnalyzers) { $R.Add(('- ' + (Get-PkgLine $e.Name))); $anyAn = $true }
    elseif ($e.Name -match '(?i)analyzer') { $otherAn += $e.Name }
}
if ($otherAn.Count -gt 0) {
    if ($Anonymize) { $R.Add(('- Other analyzer packages: ' + $otherAn.Count)) } else { $R.Add(('- Other analyzer packages: ' + ($otherAn -join ', '))) }
    $anyAn = $true
}
if (-not $anyAn) { $R.Add('- No analyzer packages referenced (SDK built-in .NET analyzers may still run).') }
foreach ($bf in $buildFlags) { $R.Add(('- ' + $bf)) }
$R.Add('')

# --- CI hints ---------------------------------------------------------------------------------------
$R.Add('## CI pipeline hints')
$R.Add('')
$R.Add('Tool names only; no URLs, tokens, project keys or property values are read into this report.')
$R.Add('')
if ($ciInfo -and $ciInfo.Count -gt 0) {
    $R.Add('| CI file | Kind | Mentions |')
    $R.Add('|---|---|---|')
    foreach ($ci in $ciInfo) {
        $label = 'CI file #' + $ci.N
        if (-not $Anonymize) { $label = '`' + (Get-RelativePathSafe $ci.Path $repoRoot) + '`' }
        $h = '(nothing relevant)'
        if ($ci.Hints.Count -gt 0) { $h = ($ci.Hints -join '; ') }
        $R.Add(('| ' + $label + ' | ' + $ci.Kind + ' | ' + $h + ' |'))
    }
} else {
    $R.Add('No CI pipeline files found in the repository (azure-pipelines*.yml, .github/workflows, Jenkinsfile, .gitlab-ci.yml, pipeline templates).')
}
if ($otherFacts -and $otherFacts.Count -gt 0) {
    $R.Add('')
    foreach ($o in ($otherFacts | Select-Object -Unique)) { $R.Add(('- ' + $o)) }
}
$R.Add('')

# --- notes ------------------------------------------------------------------------------------------
$R.Add('## Notes')
$R.Add('')
$failedSteps = @($script:Steps | Where-Object { -not $_.Ok -and $_.Name -ne 'test-solution' })
foreach ($fs in $failedSteps) { $script:Notes.Add(('Step "' + $fs.Name + '" failed with exit code ' + $fs.ExitCode + ' (' + $fs.ErrorHint + ').')) }
if ($script:Notes.Count -eq 0) { $R.Add('- none') }
foreach ($n in ($script:Notes | Select-Object -Unique)) { $R.Add(('- ' + $n)) }
$R.Add('')

$reportText = ($R -join [System.Environment]::NewLine)
Write-Host ''
Write-Host '----------------------------------------------------------------------'
Write-Host $reportText
Write-Host '----------------------------------------------------------------------'
try {
    [System.IO.File]::WriteAllText($reportPath, $reportText, (New-Object System.Text.UTF8Encoding($true)))
    Write-Host ('Report saved: ' + $reportPath) -ForegroundColor Green
} catch {
    Write-Host ('Could not save the report: ' + $_.Exception.Message) -ForegroundColor Red
}
Write-Host ('Raw logs (not part of the report, may contain paths): ' + $script:LogDir)
if ($fatal) { exit 1 }
