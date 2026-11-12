using Aftershock.Analyzer.Engine;
using Aftershock.Analyzer.Workspace;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;
using Microsoft.CodeAnalysis.Text;

namespace Aftershock.Analyzer.Tests.Infrastructure;

/// <summary>
/// One restored copy of the sample, loaded once into an MSBuildWorkspace. Scenarios apply their edits to
/// in-memory forks of the baseline solution (exactly what a long-running host would do), so the expensive
/// load and compilation happen once for the whole collection.
/// </summary>
public sealed class SampleWorkspaceFixture : IAsyncLifetime
{
    private MSBuildWorkspace? _workspace;

    internal SampleCopy Copy { get; private set; } = null!;

    public Solution Baseline { get; private set; } = null!;

    public async Task InitializeAsync()
    {
        Copy = SampleCopy.Create("engine");
        var log = new AnalysisLog(null);
        (_workspace, Baseline) = await WorkspaceLoader.LoadAsync(Copy.SolutionPath, log);
        var errors = log.Diagnostics.Where(d => d.Severity == "error").ToList();
        if (errors.Count > 0)
        {
            throw new InvalidOperationException("Sample failed to load: " + string.Join(Environment.NewLine, errors.Select(e => e.Message)));
        }

        foreach (var project in Baseline.Projects)
        {
            var compilation = await project.GetCompilationAsync();
            var compileErrors = compilation!.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
            if (compileErrors.Count > 0)
            {
                throw new InvalidOperationException($"{project.Name} does not compile: {string.Join(Environment.NewLine, compileErrors)}");
            }
        }
    }

    public Task DisposeAsync()
    {
        _workspace?.Dispose();
        Copy?.Dispose();
        return Task.CompletedTask;
    }

    public ChangeSet Change() => new(this);
}

/// <summary>Builder for an in-memory change on top of the baseline solution.</summary>
public sealed class ChangeSet
{
    private readonly SampleWorkspaceFixture _fixture;
    private readonly List<FileChange> _changes = new();
    private Solution _solution;

    internal ChangeSet(SampleWorkspaceFixture fixture)
    {
        _fixture = fixture;
        _solution = fixture.Baseline;
    }

    public Solution Solution => _solution;

    /// <summary>Replaces <paramref name="oldText"/> (must occur exactly once) in a C# file of the solution.</summary>
    public ChangeSet Replace(string relativePath, string oldText, string newText)
    {
        return Modify(relativePath, text =>
        {
            var index = text.IndexOf(oldText, StringComparison.Ordinal);
            Assert.True(index >= 0, $"'{oldText}' not found in {relativePath}");
            Assert.True(text.IndexOf(oldText, index + 1, StringComparison.Ordinal) < 0, $"'{oldText}' occurs more than once in {relativePath}");
            return text[..index] + newText + text[(index + oldText.Length)..];
        });
    }

    public ChangeSet Modify(string relativePath, Func<string, string> edit)
    {
        var path = _fixture.Copy.PathOf(relativePath);
        var ids = new SolutionModel(_solution).DocumentsAt(path);
        Assert.NotEmpty(ids);
        var oldText = _solution.GetDocument(ids[0])!.GetTextAsync().Result.ToString();
        var newText = edit(oldText);
        _solution = _solution.WithDocumentText(ids, SourceText.From(newText));

        // Several edits of one file are one change: old text = baseline, new text = latest.
        var existing = _changes.FindIndex(c => c.Path == path);
        if (existing >= 0)
        {
            _changes[existing] = _changes[existing] with { NewText = newText };
        }
        else
        {
            _changes.Add(new FileChange(path, FileChangeKind.Modified, OldText: oldText, NewText: newText, DisplayPath: _fixture.Copy.GitPathOf(relativePath)));
        }

        return this;
    }

    /// <summary>Adds a new C# file to the project that owns its folder.</summary>
    public ChangeSet Add(string relativePath, string content)
    {
        var path = _fixture.Copy.PathOf(relativePath);
        var owners = new SolutionModel(_solution).OwningProjects(path);
        Assert.NotEmpty(owners);
        foreach (var project in owners)
        {
            var projectDirectory = Path.GetDirectoryName(project.FilePath!)!;
            var folders = Path.GetRelativePath(projectDirectory, Path.GetDirectoryName(path)!)
                .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
                .Where(f => f != ".");
            _solution = _solution.AddDocument(DocumentId.CreateNewId(project.Id), Path.GetFileName(path), SourceText.From(content), folders, path);
        }

        _changes.Add(new FileChange(path, FileChangeKind.Added, NewText: content, DisplayPath: _fixture.Copy.GitPathOf(relativePath), Untracked: true));
        return this;
    }

    public ChangeSet Delete(string relativePath)
    {
        var path = _fixture.Copy.PathOf(relativePath);
        var ids = new SolutionModel(_solution).DocumentsAt(path);
        Assert.NotEmpty(ids);
        var oldText = _solution.GetDocument(ids[0])!.GetTextAsync().Result.ToString();
        _solution = _solution.RemoveDocuments(ids.ToImmutableArray());
        _changes.Add(new FileChange(path, FileChangeKind.Deleted, OldText: oldText, DisplayPath: _fixture.Copy.GitPathOf(relativePath)));
        return this;
    }

    /// <summary>Reports a change of a file without touching the solution (project files, json, ...).</summary>
    public ChangeSet Touch(string relativePath, FileChangeKind kind = FileChangeKind.Modified, string? newText = null)
    {
        var path = _fixture.Copy.PathOf(relativePath);
        _changes.Add(new FileChange(path, kind, NewText: newText, DisplayPath: _fixture.Copy.GitPathOf(relativePath), Untracked: kind == FileChangeKind.Added));
        return this;
    }

    public async Task<ImpactResult> AnalyzeAsync(ImpactOptions? options = null)
    {
        var log = new AnalysisLog(null);
        var engine = new ImpactEngine(log);
        var effective = options ?? new ImpactOptions { Timeout = TimeSpan.FromMinutes(2) };
        effective = new ImpactOptions
        {
            MaxSymbols = effective.MaxSymbols,
            Timeout = effective.Timeout,
            FallbackGlobs = effective.FallbackGlobs,
            RepositoryRoot = _fixture.Copy.RepositoryRoot,
        };

        var result = await engine.AnalyzeAsync(_solution, _changes, effective);
        Diagnostics = log.Diagnostics;
        return result;
    }

    public IReadOnlyList<Aftershock.Analyzer.Output.DiagnosticReport> Diagnostics { get; private set; } = Array.Empty<Aftershock.Analyzer.Output.DiagnosticReport>();
}

internal static class ImmutableHelpers
{
    public static System.Collections.Immutable.ImmutableArray<T> ToImmutableArray<T>(this IEnumerable<T> items) =>
        System.Collections.Immutable.ImmutableArray.CreateRange(items);
}

[CollectionDefinition(Name)]
public sealed class SampleWorkspaceCollection : ICollectionFixture<SampleWorkspaceFixture>
{
    public const string Name = "Sample workspace";
}
