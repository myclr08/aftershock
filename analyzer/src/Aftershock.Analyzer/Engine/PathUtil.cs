using System.Runtime.InteropServices;
using System.Text;

namespace Aftershock.Analyzer.Engine;

/// <summary>
/// Path helpers. Git reports forward-slash, repository-relative paths; Roslyn reports absolute OS paths.
/// Everything is normalized to absolute OS paths and compared case-insensitively on Windows and macOS.
/// </summary>
public static class PathUtil
{
    public static bool IsCaseInsensitive { get; } = OperatingSystem.IsWindows() || OperatingSystem.IsMacOS();

    public static StringComparer Comparer { get; } = IsCaseInsensitive ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    public static StringComparison Comparison { get; } = IsCaseInsensitive ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>
    /// Returns a normalized absolute path (OS separators, no trailing separator). On Windows, 8.3 short names
    /// (for example <c>C:\Users\RUNNER~1</c> in %TEMP%) are expanded, because git always reports long names.
    /// </summary>
    public static string Normalize(string path)
    {
        var full = Path.GetFullPath(path);
        if (OperatingSystem.IsWindows() && full.Contains('~'))
        {
            full = ExpandShortName(full);
        }

        if (full.Length > 1)
        {
            var root = Path.GetPathRoot(full) ?? string.Empty;
            if (full.Length > root.Length)
            {
                full = full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            }
        }

        return full;
    }

    /// <summary>Combines a repository root with a git (forward-slash, relative) path.</summary>
    public static string FromGitPath(string repositoryRoot, string gitPath)
    {
        var relative = gitPath.Replace('/', Path.DirectorySeparatorChar);
        return Normalize(Path.Combine(repositoryRoot, relative));
    }

    /// <summary>Repository-relative path with forward slashes, or the absolute path when outside the root.</summary>
    public static string ToGitPath(string repositoryRoot, string fullPath)
    {
        var relative = Path.GetRelativePath(repositoryRoot, fullPath);
        if (relative.StartsWith("..", StringComparison.Ordinal) || Path.IsPathRooted(relative))
        {
            return fullPath.Replace('\\', '/');
        }

        return relative.Replace('\\', '/');
    }

    public static bool PathEquals(string? a, string? b)
    {
        if (a is null || b is null)
        {
            return false;
        }

        return string.Equals(a, b, Comparison);
    }

    /// <summary>True when <paramref name="path"/> equals <paramref name="directory"/> or lies below it.</summary>
    public static bool IsUnder(string path, string directory)
    {
        if (PathEquals(path, directory))
        {
            return true;
        }

        var dir = directory.EndsWith(Path.DirectorySeparatorChar) ? directory : directory + Path.DirectorySeparatorChar;
        return path.StartsWith(dir, Comparison);
    }

    /// <summary>Normalized directory of a file path.</summary>
    public static string? DirectoryOf(string? path)
    {
        return path is null ? null : Path.GetDirectoryName(Normalize(path));
    }

    private static string ExpandShortName(string path)
    {
        // The deepest existing ancestor is expanded; a not-yet-existing tail (deleted file) is appended unchanged.
        var existing = path;
        var tail = string.Empty;
        while (!File.Exists(existing) && !Directory.Exists(existing))
        {
            var parent = Path.GetDirectoryName(existing);
            if (parent is null)
            {
                return path;
            }

            tail = Path.Combine(Path.GetFileName(existing), tail);
            existing = parent;
        }

        var buffer = new StringBuilder(1024);
        var length = GetLongPathName(existing, buffer, buffer.Capacity);
        if (length == 0 || length > buffer.Capacity)
        {
            return path;
        }

        var expanded = buffer.ToString();
        return tail.Length == 0 ? expanded : Path.Combine(expanded, tail.TrimEnd(Path.DirectorySeparatorChar));
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetLongPathName(string shortPath, StringBuilder longPath, int bufferLength);
}
