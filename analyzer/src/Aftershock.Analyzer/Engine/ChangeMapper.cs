using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Text;

namespace Aftershock.Analyzer.Engine;

public enum ChangeReason
{
    Modified,
    Added,
    Deleted,
    TypeChanged,
    FileChanged,
    NewFile,
    DeletedFile,
}

/// <summary>A syntactically confirmed change, before symbols are resolved.</summary>
/// <param name="Document">Document in the new solution, or in the old fork when <paramref name="InOld"/> is set.</param>
/// <param name="InOld">True when the change only exists in the old snapshot (deleted members, types and files).</param>
/// <param name="Context">Member context; null for type-level changes.</param>
/// <param name="TypeNode">Type declaration for type-level changes.</param>
/// <param name="IncludeConstructors">Instance constructors run the changed code too (instance property initializer).</param>
/// <param name="MemberAddedOnly">
/// Type-level change whose only cause is one or more added members. The engine applies the "added member changes
/// every member of the type" rule to production types only, not to types of test projects.
/// </param>
public sealed record PendingChange(
    DocumentId Document,
    bool InOld,
    SyntaxContext? Context,
    MemberDeclarationSyntax? TypeNode,
    ChangeReason Reason,
    string? Detail,
    bool IncludeConstructors = false,
    bool MemberAddedOnly = false);

/// <summary>
/// Turns "old text vs new text" into changed members: line diff first, then each changed line is mapped to the
/// innermost member (method, constructor, accessor, operator, ...). Candidates are confirmed by comparing the old
/// and new declaration with trivia ignored, so comment/whitespace edits and diff alignment artifacts drop out.
/// </summary>
public static class ChangeMapper
{
    public static async Task<IReadOnlyList<PendingChange>> MapModifiedAsync(Document newDocument, Document oldDocument, CancellationToken cancellationToken)
    {
        var newText = await newDocument.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var oldText = await oldDocument.GetTextAsync(cancellationToken).ConfigureAwait(false);
        var newRoot = await newDocument.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        var oldRoot = await oldDocument.GetSyntaxRootAsync(cancellationToken).ConfigureAwait(false);
        if (newRoot is null || oldRoot is null)
        {
            return Array.Empty<PendingChange>();
        }

        var hunks = LineDiff.Compute(oldText, newText);
        return MapHunks(hunks, oldRoot, oldText, oldDocument.Id, newRoot, newText, newDocument.Id);
    }

    public static IReadOnlyList<PendingChange> MapHunks(
        IReadOnlyList<DiffHunk> hunks,
        SyntaxNode oldRoot,
        SourceText oldText,
        DocumentId oldDocument,
        SyntaxNode newRoot,
        SourceText newText,
        DocumentId newDocument)
    {
        var oldCandidates = new List<SyntaxContext>();
        var newCandidates = new List<SyntaxContext>();
        foreach (var hunk in hunks)
        {
            oldCandidates.AddRange(ContextsForLines(oldRoot, oldText, hunk.OldStart, hunk.OldCount));
            newCandidates.AddRange(ContextsForLines(newRoot, newText, hunk.NewStart, hunk.NewCount));
        }

        var oldIndex = SyntaxMembers.IndexMembers(oldRoot);
        var newIndex = SyntaxMembers.IndexMembers(newRoot);
        var oldTypes = TypesByKey(oldRoot);
        var newTypes = TypesByKey(newRoot);

        var result = new List<PendingChange>();
        var seenMembers = new HashSet<string>(StringComparer.Ordinal);
        var seenTypes = new Dictionary<string, int>(StringComparer.Ordinal);
        var fileLevelChecked = false;

        void AddType(MemberDeclarationSyntax typeNode, bool inOld, ChangeReason reason, string? detail, bool memberAddedOnly = false)
        {
            var key = (inOld ? "old:" : "new:") + SyntaxMembers.TypeKey(typeNode);
            var change = new PendingChange(inOld ? oldDocument : newDocument, inOld, null, typeNode, reason, detail, MemberAddedOnly: memberAddedOnly);
            if (!seenTypes.TryGetValue(key, out var existing))
            {
                seenTypes[key] = result.Count;
                result.Add(change);
            }
            else if (result[existing].MemberAddedOnly && !memberAddedOnly)
            {
                // A stronger reason (attributes, base types, fields, ...) replaces "only members were added".
                result[existing] = change;
            }
        }

        void CheckType(string typeKey)
        {
            var hasOld = oldTypes.TryGetValue(typeKey, out var oldType);
            var hasNew = newTypes.TryGetValue(typeKey, out var newType);
            if (hasOld && hasNew)
            {
                var difference = DescribeTypeDifference(oldType!, newType!);
                if (difference is { } d)
                {
                    AddType(newType!, inOld: false, ChangeReason.TypeChanged, d.Detail, d.MemberAddedOnly);
                }
            }
            else if (hasNew)
            {
                AddType(newType!, inOld: false, ChangeReason.Added, "type added");
            }
            else if (hasOld)
            {
                AddType(oldType!, inOld: true, ChangeReason.Deleted, "type removed");
            }
        }

        void CheckFile()
        {
            if (fileLevelChecked)
            {
                return;
            }

            fileLevelChecked = true;
            if (SyntaxMembers.FileShapesEqual(oldRoot, newRoot))
            {
                return;
            }

            foreach (var (key, type) in newTypes)
            {
                AddType(type, inOld: false, ChangeReason.FileChanged, "usings, namespace or assembly attributes changed");
            }

            foreach (var (key, type) in oldTypes)
            {
                if (!newTypes.ContainsKey(key))
                {
                    AddType(type, inOld: true, ChangeReason.Deleted, "type removed");
                }
            }
        }

        var modifiedIndex = new Dictionary<string, int>(StringComparer.Ordinal);

        void AddModified(string key, SyntaxContext newContext, bool includeConstructors)
        {
            if (modifiedIndex.TryGetValue(key, out var existing))
            {
                if (includeConstructors && !result[existing].IncludeConstructors)
                {
                    result[existing] = result[existing] with { IncludeConstructors = true };
                }

                return;
            }

            modifiedIndex[key] = result.Count;
            result.Add(new PendingChange(newDocument, InOld: false, newContext, null, ChangeReason.Modified, null, includeConstructors));
        }

        void CheckMember(SyntaxContext context, bool fromOld)
        {
            var key = SyntaxMembers.MemberKey(context);
            if (key is null)
            {
                return;
            }

            if (!seenMembers.Add((fromOld ? "old:" : "new:") + key + "#" + context.Kind))
            {
                return;
            }

            var thisIndex = fromOld ? oldIndex : newIndex;
            var otherIndex = fromOld ? newIndex : oldIndex;
            if (!thisIndex.TryGetValue(key, out var self))
            {
                self = context;
            }

            if (otherIndex.TryGetValue(key, out var counterpart))
            {
                var (oldContext, newContext) = fromOld ? (self, counterpart) : (counterpart, self);
                if (SyntaxMembers.PartEquivalent(oldContext, newContext, context.Kind))
                {
                    return;
                }

                AddModified(key, newContext, context.Kind == ContextKind.PropertyInitializer && HasChangedInstanceInitializer(oldContext, newContext));
                return;
            }

            // An accessor appeared or disappeared: the owning property/indexer/event changed as a whole.
            var owner = SyntaxMembers.OwnerOfAccessorKey(key);
            if (owner is not null && thisIndex.TryGetValue(owner, out var ownerContext))
            {
                if (newIndex.TryGetValue(owner, out var newOwner) && oldIndex.ContainsKey(owner))
                {
                    AddModified(owner, newOwner, includeConstructors: false);
                }
                else
                {
                    CheckMember(ownerContext, fromOld);
                }

                return;
            }

            if (fromOld)
            {
                result.Add(new PendingChange(oldDocument, InOld: true, self, null, ChangeReason.Deleted, null));
            }
            else
            {
                result.Add(new PendingChange(newDocument, InOld: false, self, null, ChangeReason.Added, null));
                if (self.Type is { } containingType)
                {
                    AddType(containingType, inOld: false, ChangeReason.TypeChanged, $"member added: {DescribeMember(self)}", memberAddedOnly: true);
                }
            }
        }

        foreach (var (candidates, fromOld) in new[] { (newCandidates, false), (oldCandidates, true) })
        {
            foreach (var context in candidates)
            {
                switch (context.Kind)
                {
                    case ContextKind.Field:
                    case ContextKind.FieldInitializer:
                    case ContextKind.TypeHeader:
                    case ContextKind.PrimaryConstructorBase:
                        if (context.Type is { } typeNode)
                        {
                            CheckType(SyntaxMembers.TypeKey(typeNode));
                        }

                        break;
                    case ContextKind.FileLevel:
                        CheckFile();
                        break;
                    default:
                        CheckMember(context, fromOld);
                        break;
                }
            }
        }

        return result;
    }

    /// <summary>Every type declared in a new file (or an old, deleted file).</summary>
    public static IReadOnlyList<PendingChange> MapWholeFile(SyntaxNode root, DocumentId document, bool inOld)
    {
        var result = new List<PendingChange>();
        var reason = inOld ? ChangeReason.DeletedFile : ChangeReason.NewFile;
        foreach (var type in SyntaxMembers.TypeDeclarations(root))
        {
            result.Add(new PendingChange(document, inOld, null, type, reason, null));
        }

        if (root is CompilationUnitSyntax unit && unit.Members.OfType<GlobalStatementSyntax>().Any())
        {
            result.Add(new PendingChange(document, inOld, new SyntaxContext(ContextKind.GlobalStatement, unit), null, reason, "top-level statements"));
        }

        return result;
    }

    /// <summary>Distinct syntactic contexts touched by the given lines; whitespace- and comment-only lines are skipped.</summary>
    public static IEnumerable<SyntaxContext> ContextsForLines(SyntaxNode root, SourceText text, int start, int count)
    {
        var seen = new HashSet<(ContextKind, SyntaxNode)>();
        for (var line = start; line < start + count && line < text.Lines.Count; line++)
        {
            var span = text.Lines[line].Span;
            if (span.IsEmpty)
            {
                continue;
            }

            var any = false;
            foreach (var token in root.DescendantTokens(span))
            {
                if (token.Span.IsEmpty || !token.Span.OverlapsWith(span))
                {
                    continue;
                }

                any = true;
                var context = SyntaxMembers.Classify(token);
                if (seen.Add((context.Kind, context.Node)))
                {
                    yield return context;
                }
            }

            if (any)
            {
                continue;
            }

            // A line without tokens: only preprocessor directives and inactive code are significant.
            var significantTrivia = root.DescendantTrivia(span, descendIntoTrivia: false)
                .Any(t => t.Span.OverlapsWith(span) && (t.IsDirective || t.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.DisabledTextTrivia)));
            if (significantTrivia)
            {
                var context = SyntaxMembers.Classify(root.FindToken(span.Start));
                if (seen.Add((context.Kind, context.Node)))
                {
                    yield return context;
                }
            }
        }
    }

    private static Dictionary<string, MemberDeclarationSyntax> TypesByKey(SyntaxNode root)
    {
        var result = new Dictionary<string, MemberDeclarationSyntax>(StringComparer.Ordinal);
        foreach (var type in SyntaxMembers.TypeDeclarations(root))
        {
            result.TryAdd(SyntaxMembers.TypeKey(type), type);
        }

        return result;
    }

    private static bool HasChangedInstanceInitializer(SyntaxContext oldContext, SyntaxContext newContext)
    {
        if (oldContext.Node is not PropertyDeclarationSyntax oldProperty || newContext.Node is not PropertyDeclarationSyntax newProperty)
        {
            return false;
        }

        if (newProperty.Modifiers.Any(Microsoft.CodeAnalysis.CSharp.SyntaxKind.StaticKeyword))
        {
            return false;
        }

        var a = oldProperty.Initializer;
        var b = newProperty.Initializer;
        if (a is null || b is null)
        {
            return a is not null || b is not null;
        }

        return !Microsoft.CodeAnalysis.CSharp.SyntaxFactory.AreEquivalent(a, b, topLevel: false);
    }

    private static string DescribeMember(SyntaxContext context)
    {
        return context.Node switch
        {
            MethodDeclarationSyntax m => m.Identifier.ValueText,
            ConstructorDeclarationSyntax => "constructor",
            PropertyDeclarationSyntax p => p.Identifier.ValueText,
            IndexerDeclarationSyntax => "indexer",
            EventDeclarationSyntax e => e.Identifier.ValueText,
            EventFieldDeclarationSyntax ef => string.Join(", ", ef.Declaration.Variables.Select(v => v.Identifier.ValueText)),
            EnumMemberDeclarationSyntax em => em.Identifier.ValueText,
            OperatorDeclarationSyntax o => "operator " + o.OperatorToken.ValueText,
            _ => context.Node.Kind().ToString(),
        };
    }

    /// <summary>
    /// What changed outside the members of a type, or null when nothing did. A difference that consists only of
    /// removed members is null too: deleted members are handled one by one through the old snapshot.
    /// </summary>
    private static (string Detail, bool MemberAddedOnly)? DescribeTypeDifference(MemberDeclarationSyntax oldType, MemberDeclarationSyntax newType)
    {
        if (SyntaxMembers.TypeShapesEqual(oldType, newType))
        {
            return null;
        }

        static bool Same(SyntaxNode? a, SyntaxNode? b) =>
            a is null || b is null ? a is null && b is null : Microsoft.CodeAnalysis.CSharp.SyntaxFactory.AreEquivalent(a, b, topLevel: false);

        var parts = new List<string>();
        if (oldType.AttributeLists.Count != newType.AttributeLists.Count
            || !oldType.AttributeLists.Zip(newType.AttributeLists).All(p => Same(p.First, p.Second)))
        {
            parts.Add("attributes");
        }

        if (!oldType.Modifiers.Select(m => m.ValueText).SequenceEqual(newType.Modifiers.Select(m => m.ValueText)))
        {
            parts.Add("modifiers");
        }

        if (oldType is TypeDeclarationSyntax o && newType is TypeDeclarationSyntax n)
        {
            if (!Same(o.BaseList, n.BaseList))
            {
                parts.Add("base types");
            }

            if (!Same(o.ParameterList, n.ParameterList))
            {
                parts.Add("primary constructor");
            }

            if (!Same(o.TypeParameterList, n.TypeParameterList) || o.ConstraintClauses.Count != n.ConstraintClauses.Count
                || !o.ConstraintClauses.Zip(n.ConstraintClauses).All(p => Same(p.First, p.Second)))
            {
                parts.Add("type parameters");
            }

            var oldFields = o.Members.OfType<BaseFieldDeclarationSyntax>().ToList();
            var newFields = n.Members.OfType<BaseFieldDeclarationSyntax>().ToList();
            if (oldFields.Count != newFields.Count || !oldFields.Zip(newFields).All(p => Same(p.First, p.Second)))
            {
                parts.Add("fields");
            }

            if (parts.Count == 0)
            {
                var added = SyntaxMembers.MemberKeySet(n);
                added.ExceptWith(SyntaxMembers.MemberKeySet(o));
                if (added.Count == 0)
                {
                    return null;
                }

                return ("member added: " + string.Join(", ", added.Select(k => k[(k.IndexOf("::", StringComparison.Ordinal) + 4)..]).OrderBy(k => k, StringComparer.Ordinal)), true);
            }
        }

        if (parts.Count == 0)
        {
            // Enums (a removed or inserted member shifts implicit values) and other declarations.
            parts.Add("member list");
        }

        return (string.Join(", ", parts) + " changed", false);
    }
}
