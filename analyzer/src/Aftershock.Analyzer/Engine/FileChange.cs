namespace Aftershock.Analyzer.Engine;

public enum FileChangeKind
{
    Added,
    Modified,
    Deleted,
    Renamed,
}

/// <summary>
/// One changed file, described as "old snapshot vs new content". The engine never talks to git:
/// the CLI fills these from <c>git</c>, a long-running server can fill them from in-memory snapshots.
/// </summary>
/// <param name="Path">Absolute path of the file in the new state (for a deleted file: its last path).</param>
/// <param name="Kind">What happened to the file.</param>
/// <param name="OldPath">Absolute path in the old snapshot when it differs (renames).</param>
/// <param name="OldText">Content in the old snapshot; null when the file did not exist or is not needed.</param>
/// <param name="NewText">
/// Content in the new snapshot; null when deleted or not needed. For C# documents that are part of the
/// workspace, the text of the <see cref="Microsoft.CodeAnalysis.Solution"/> passed to the engine is authoritative.
/// </param>
/// <param name="DisplayPath">Path used in reports (the CLI uses the repository-relative git path).</param>
/// <param name="OldDisplayPath">Display path of <paramref name="OldPath"/>.</param>
/// <param name="Untracked">True for files git does not track yet.</param>
public sealed record FileChange(
    string Path,
    FileChangeKind Kind,
    string? OldPath = null,
    string? OldText = null,
    string? NewText = null,
    string? DisplayPath = null,
    string? OldDisplayPath = null,
    bool Untracked = false)
{
    public string EffectiveOldPath => OldPath ?? Path;

    public string Display => DisplayPath ?? Path;

    public bool IsCSharp => Path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)
        || (OldPath?.EndsWith(".cs", StringComparison.OrdinalIgnoreCase) ?? false);
}
