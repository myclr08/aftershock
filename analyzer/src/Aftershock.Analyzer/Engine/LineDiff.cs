using DiffPlex;
using DiffPlex.Chunkers;
using Microsoft.CodeAnalysis.Text;

namespace Aftershock.Analyzer.Engine;

/// <summary>One differing region: lines removed from the old text and lines inserted into the new text (0-based).</summary>
public readonly record struct DiffHunk(int OldStart, int OldCount, int NewStart, int NewCount);

/// <summary>
/// Line diff between two snapshots. Lines are split exactly like Roslyn's <see cref="SourceText.Lines"/>, so the
/// hunk line numbers can be used directly against syntax trees. Line terminators are not compared, which makes
/// CRLF/LF differences (e.g. <c>core.autocrlf</c>) invisible.
/// </summary>
public static class LineDiff
{
    public static IReadOnlyList<DiffHunk> Compute(SourceText oldText, SourceText newText)
    {
        var oldLines = SplitLines(oldText);
        var newLines = SplitLines(newText);
        var chunker = new PreSplitChunker(oldLines, newLines);
        var result = Differ.Instance.CreateDiffs("old", "new", ignoreWhiteSpace: false, ignoreCase: false, chunker);
        return result.DiffBlocks
            .Select(b => new DiffHunk(b.DeleteStartA, b.DeleteCountA, b.InsertStartB, b.InsertCountB))
            .ToList();
    }

    public static string[] SplitLines(SourceText text)
    {
        var lines = new string[text.Lines.Count];
        for (var i = 0; i < lines.Length; i++)
        {
            lines[i] = text.Lines[i].ToString();
        }

        return lines;
    }

    /// <summary>Hands DiffPlex the already split lines (it calls the chunker once for each side).</summary>
    private sealed class PreSplitChunker : IChunker
    {
        private readonly string[] _old;
        private readonly string[] _new;

        public PreSplitChunker(string[] oldLines, string[] newLines)
        {
            _old = oldLines;
            _new = newLines;
        }

        public IReadOnlyList<string> Chunk(string text) => text == "old" ? _old : _new;
    }
}
