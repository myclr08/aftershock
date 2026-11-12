using System.Text;
using System.Text.RegularExpressions;

namespace Aftershock.Analyzer.Engine;

/// <summary>
/// Minimal glob matcher for forward-slash relative paths.
/// Supports <c>**</c> (any number of directories), <c>*</c>, <c>?</c>, <c>{a,b}</c> and <c>[...]</c>.
/// A pattern without a slash matches the file name at any depth.
/// </summary>
public sealed class GlobMatcher
{
    private readonly Regex _regex;
    private readonly bool _fileNameOnly;

    public GlobMatcher(string pattern)
    {
        Pattern = pattern;
        var normalized = pattern.Replace('\\', '/').Trim();
        if (normalized.StartsWith("./", StringComparison.Ordinal))
        {
            normalized = normalized[2..];
        }

        _fileNameOnly = !normalized.Contains('/');
        var options = RegexOptions.CultureInvariant | (PathUtil.IsCaseInsensitive ? RegexOptions.IgnoreCase : RegexOptions.None);
        _regex = new Regex("^" + ToRegex(normalized) + "$", options);
    }

    public string Pattern { get; }

    public bool IsMatch(string relativePath)
    {
        var path = relativePath.Replace('\\', '/');
        if (_fileNameOnly)
        {
            var slash = path.LastIndexOf('/');
            path = slash >= 0 ? path[(slash + 1)..] : path;
        }

        return _regex.IsMatch(path);
    }

    private static string ToRegex(string glob)
    {
        var sb = new StringBuilder();
        var braceDepth = 0;
        for (var i = 0; i < glob.Length; i++)
        {
            var c = glob[i];
            switch (c)
            {
                case '*':
                    if (i + 1 < glob.Length && glob[i + 1] == '*')
                    {
                        i++;
                        if (i + 1 < glob.Length && glob[i + 1] == '/')
                        {
                            i++;
                            sb.Append("(?:.*/)?");
                        }
                        else
                        {
                            sb.Append(".*");
                        }
                    }
                    else
                    {
                        sb.Append("[^/]*");
                    }

                    break;
                case '?':
                    sb.Append("[^/]");
                    break;
                case '{':
                    braceDepth++;
                    sb.Append("(?:");
                    break;
                case '}' when braceDepth > 0:
                    braceDepth--;
                    sb.Append(')');
                    break;
                case ',' when braceDepth > 0:
                    sb.Append('|');
                    break;
                case '[':
                    var end = glob.IndexOf(']', i + 1);
                    if (end < 0)
                    {
                        sb.Append("\\[");
                    }
                    else
                    {
                        var body = glob.Substring(i + 1, end - i - 1);
                        if (body.StartsWith('!'))
                        {
                            body = "^" + body[1..];
                        }

                        sb.Append('[').Append(body.Replace("\\", "\\\\")).Append(']');
                        i = end;
                    }

                    break;
                default:
                    sb.Append(Regex.Escape(c.ToString()));
                    break;
            }
        }

        return sb.ToString();
    }
}
