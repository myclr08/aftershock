using System.Diagnostics;
using System.Text;

namespace Aftershock.Analyzer.Git;

public sealed record GitResult(int ExitCode, byte[] Output, string Error)
{
    public string Text => Encoding.UTF8.GetString(Output);
}

/// <summary>One entry of <c>git diff --name-status</c> (paths are repository-relative with forward slashes).</summary>
public sealed record GitDiffEntry(char Status, string Path, string? OldPath);

/// <summary>Thin wrapper around the git command line (plumbing commands, NUL-separated output, no shell).</summary>
public sealed class GitClient
{
    private readonly string _workingDirectory;

    public GitClient(string workingDirectory)
    {
        _workingDirectory = workingDirectory;
    }

    public string WorkingDirectory => _workingDirectory;

    public async Task<GitResult> RunAsync(IEnumerable<string> arguments, byte[]? input = null, CancellationToken cancellationToken = default)
    {
        var startInfo = new ProcessStartInfo("git")
        {
            WorkingDirectory = _workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = input is not null,
            UseShellExecute = false,
            CreateNoWindow = true,
            StandardErrorEncoding = Encoding.UTF8,
        };
        startInfo.ArgumentList.Add("-c");
        startInfo.ArgumentList.Add("core.quotepath=off");
        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        startInfo.Environment["GIT_TERMINAL_PROMPT"] = "0";
        startInfo.Environment["GIT_OPTIONAL_LOCKS"] = "0";

        using var process = new Process { StartInfo = startInfo };
        try
        {
            process.Start();
        }
        catch (Exception ex)
        {
            throw new InvalidOperationException($"could not start git ({ex.Message}); is git installed and on PATH?", ex);
        }

        var outputTask = ReadAllAsync(process.StandardOutput.BaseStream, cancellationToken);
        var errorTask = process.StandardError.ReadToEndAsync(cancellationToken);
        if (input is not null)
        {
            await process.StandardInput.BaseStream.WriteAsync(input, cancellationToken).ConfigureAwait(false);
            process.StandardInput.Close();
        }

        var output = await outputTask.ConfigureAwait(false);
        var error = await errorTask.ConfigureAwait(false);
        await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
        return new GitResult(process.ExitCode, output, error);
    }

    /// <summary>Absolute path of the repository root, or null when not inside a work tree.</summary>
    public async Task<string?> GetTopLevelAsync(CancellationToken cancellationToken = default)
    {
        var result = await RunAsync(new[] { "rev-parse", "--show-toplevel" }, cancellationToken: cancellationToken).ConfigureAwait(false);
        if (result.ExitCode != 0)
        {
            return null;
        }

        var path = result.Text.Trim();
        return path.Length == 0 ? null : Path.GetFullPath(path);
    }

    /// <summary>Full commit id for a revision, or null when it does not resolve to a commit.</summary>
    public async Task<string?> ResolveCommitAsync(string revision, CancellationToken cancellationToken = default)
    {
        var result = await RunAsync(new[] { "rev-parse", "--verify", "--quiet", "--end-of-options", revision + "^{commit}" }, cancellationToken: cancellationToken).ConfigureAwait(false);
        var sha = result.Text.Trim();
        return result.ExitCode == 0 && sha.Length >= 40 ? sha : null;
    }

    /// <summary>Best common ancestor of two revisions (<c>git merge-base</c>), or null when there is none or a revision does not resolve.</summary>
    public async Task<string?> MergeBaseAsync(string first, string second, CancellationToken cancellationToken = default)
    {
        var result = await RunAsync(new[] { "merge-base", "--end-of-options", first, second }, cancellationToken: cancellationToken).ConfigureAwait(false);
        var sha = result.Text.Trim();
        return result.ExitCode == 0 && sha.Length >= 40 ? sha : null;
    }

    /// <summary>Tracked changes between <paramref name="commit"/> and the working tree (staged and unstaged), renames detected.</summary>
    public async Task<IReadOnlyList<GitDiffEntry>> DiffNameStatusAsync(string commit, CancellationToken cancellationToken = default)
    {
        var result = await RunAsync(
            new[] { "diff", "--name-status", "-z", "--find-renames", "--ignore-submodules=all", "--no-ext-diff", commit, "--" },
            cancellationToken: cancellationToken).ConfigureAwait(false);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException($"git diff failed: {result.Error.Trim()}");
        }

        var tokens = SplitNul(result.Output);
        var entries = new List<GitDiffEntry>();
        for (var i = 0; i < tokens.Count;)
        {
            var status = tokens[i++];
            if (status.Length == 0)
            {
                continue;
            }

            var code = status[0];
            if (code is 'R' or 'C')
            {
                if (i + 1 >= tokens.Count)
                {
                    break;
                }

                var oldPath = tokens[i++];
                var newPath = tokens[i++];
                entries.Add(new GitDiffEntry(code, newPath, oldPath));
            }
            else
            {
                if (i >= tokens.Count)
                {
                    break;
                }

                entries.Add(new GitDiffEntry(code, tokens[i++], null));
            }
        }

        return entries;
    }

    /// <summary>Untracked files that are not ignored.</summary>
    public async Task<IReadOnlyList<string>> UntrackedFilesAsync(CancellationToken cancellationToken = default)
    {
        var result = await RunAsync(new[] { "ls-files", "--others", "--exclude-standard", "-z", "--full-name" }, cancellationToken: cancellationToken).ConfigureAwait(false);
        if (result.ExitCode != 0)
        {
            throw new InvalidOperationException($"git ls-files failed: {result.Error.Trim()}");
        }

        return SplitNul(result.Output).Where(t => t.Length > 0).ToList();
    }

    /// <summary>Reads files at a commit with one <c>git cat-file --batch</c> process. Missing paths map to null.</summary>
    public async Task<Dictionary<string, byte[]?>> ReadBlobsAsync(string commit, IReadOnlyCollection<string> paths, CancellationToken cancellationToken = default)
    {
        var result = new Dictionary<string, byte[]?>(StringComparer.Ordinal);
        var requests = paths.Distinct(StringComparer.Ordinal).ToList();
        if (requests.Count == 0)
        {
            return result;
        }

        var batchable = requests.Where(p => !p.Contains('\n')).ToList();
        var input = Encoding.UTF8.GetBytes(string.Concat(batchable.Select(p => $"{commit}:{p}\n")));
        var output = await RunAsync(new[] { "cat-file", "--batch" }, input, cancellationToken).ConfigureAwait(false);
        if (output.ExitCode != 0)
        {
            throw new InvalidOperationException($"git cat-file failed: {output.Error.Trim()}");
        }

        var data = output.Output;
        var position = 0;
        foreach (var path in batchable)
        {
            var newline = Array.IndexOf(data, (byte)'\n', position);
            if (newline < 0)
            {
                break;
            }

            var header = Encoding.UTF8.GetString(data, position, newline - position);
            position = newline + 1;
            var parts = header.Split(' ');
            if (parts.Length == 3 && long.TryParse(parts[2], out var size))
            {
                var content = new byte[size];
                Array.Copy(data, position, content, 0, size);
                position += (int)size + 1;
                result[path] = parts[1] == "blob" ? content : null;
            }
            else
            {
                result[path] = null;
            }
        }

        foreach (var path in requests.Except(batchable))
        {
            var show = await RunAsync(new[] { "show", $"{commit}:{path}" }, cancellationToken: cancellationToken).ConfigureAwait(false);
            result[path] = show.ExitCode == 0 ? show.Output : null;
        }

        return result;
    }

    private static List<string> SplitNul(byte[] data)
    {
        var tokens = new List<string>();
        var start = 0;
        for (var i = 0; i < data.Length; i++)
        {
            if (data[i] == 0)
            {
                tokens.Add(Encoding.UTF8.GetString(data, start, i - start));
                start = i + 1;
            }
        }

        if (start < data.Length)
        {
            tokens.Add(Encoding.UTF8.GetString(data, start, data.Length - start).TrimEnd('\n'));
        }

        return tokens;
    }

    private static async Task<byte[]> ReadAllAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        await stream.CopyToAsync(buffer, cancellationToken).ConfigureAwait(false);
        return buffer.ToArray();
    }
}
