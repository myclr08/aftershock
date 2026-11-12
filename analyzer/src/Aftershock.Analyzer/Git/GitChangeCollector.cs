using System.Text;
using Aftershock.Analyzer.Engine;

namespace Aftershock.Analyzer.Git;

/// <summary>
/// Produces <see cref="FileChange"/>s for "base commit vs working tree": tracked changes (staged or not, renames
/// detected), deletions and untracked files. Old content comes from the base commit, new content from disk.
/// Contents are only loaded for C# files; other files are classified by path.
/// </summary>
public static class GitChangeCollector
{
    public static async Task<IReadOnlyList<FileChange>> CollectAsync(GitClient git, string repositoryRoot, string baseCommit, CancellationToken cancellationToken = default)
    {
        var entries = await git.DiffNameStatusAsync(baseCommit, cancellationToken).ConfigureAwait(false);
        var untracked = await git.UntrackedFilesAsync(cancellationToken).ConfigureAwait(false);

        var oldPaths = entries
            .Where(e => e.Status is not 'A' and not 'C' && IsCSharp(e.OldPath ?? e.Path))
            .Select(e => e.OldPath ?? e.Path)
            .ToList();
        var blobs = await git.ReadBlobsAsync(baseCommit, oldPaths, cancellationToken).ConfigureAwait(false);

        var changes = new List<FileChange>();
        foreach (var entry in entries)
        {
            var kind = entry.Status switch
            {
                'A' or 'C' => FileChangeKind.Added,
                'D' => FileChangeKind.Deleted,
                'R' => FileChangeKind.Renamed,
                _ => FileChangeKind.Modified,
            };

            var fullPath = PathUtil.FromGitPath(repositoryRoot, entry.Path);
            var oldGitPath = kind == FileChangeKind.Renamed ? entry.OldPath : null;
            string? oldText = null;
            string? newText = null;
            if (IsCSharp(entry.Path) || (oldGitPath is not null && IsCSharp(oldGitPath)))
            {
                if (kind != FileChangeKind.Added && blobs.TryGetValue(oldGitPath ?? entry.Path, out var blob) && blob is not null)
                {
                    oldText = TextDecoding.Decode(blob);
                }

                if (kind != FileChangeKind.Deleted && File.Exists(fullPath))
                {
                    newText = TextDecoding.Decode(await File.ReadAllBytesAsync(fullPath, cancellationToken).ConfigureAwait(false));
                }
            }

            changes.Add(new FileChange(
                fullPath,
                kind,
                OldPath: oldGitPath is null ? null : PathUtil.FromGitPath(repositoryRoot, oldGitPath),
                OldText: oldText,
                NewText: newText,
                DisplayPath: entry.Path,
                OldDisplayPath: oldGitPath));
        }

        foreach (var path in untracked)
        {
            var fullPath = PathUtil.FromGitPath(repositoryRoot, path);
            string? newText = null;
            if (IsCSharp(path) && File.Exists(fullPath))
            {
                newText = TextDecoding.Decode(await File.ReadAllBytesAsync(fullPath, cancellationToken).ConfigureAwait(false));
            }

            changes.Add(new FileChange(fullPath, FileChangeKind.Added, NewText: newText, DisplayPath: path, Untracked: true));
        }

        return changes;
    }

    private static bool IsCSharp(string path) => path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase);
}

public static class TextDecoding
{
    private static readonly UTF8Encoding StrictUtf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    /// <summary>BOM-aware decoding; UTF-8 without BOM, falling back to Latin-1 for legacy 8-bit files.</summary>
    public static string Decode(byte[] bytes)
    {
        if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF)
        {
            return Encoding.UTF8.GetString(bytes, 3, bytes.Length - 3);
        }

        if (bytes.Length >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE)
        {
            return Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        }

        if (bytes.Length >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF)
        {
            return Encoding.BigEndianUnicode.GetString(bytes, 2, bytes.Length - 2);
        }

        try
        {
            return StrictUtf8.GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return Encoding.Latin1.GetString(bytes);
        }
    }
}
