using Microsoft.CodeAnalysis;

namespace Aftershock.Analyzer.Engine;

public static class SymbolNames
{
    private static readonly SymbolDisplayFormat TypeFormat = new(
        typeQualificationStyle: SymbolDisplayTypeQualificationStyle.NameAndContainingTypes,
        genericsOptions: SymbolDisplayGenericsOptions.IncludeTypeParameters);

    private static readonly SymbolDisplayFormat FullFormat = SymbolDisplayFormat.CSharpErrorMessageFormat
        .WithMemberOptions(SymbolDisplayMemberOptions.IncludeContainingType | SymbolDisplayMemberOptions.IncludeParameters | SymbolDisplayMemberOptions.IncludeExplicitInterface)
        .WithParameterOptions(SymbolDisplayParameterOptions.IncludeType | SymbolDisplayParameterOptions.IncludeParamsRefOut)
        .WithMiscellaneousOptions(SymbolDisplayMiscellaneousOptions.UseSpecialTypes);

    /// <summary>Short chain label: <c>Type.Member</c> (constructors as <c>Type..ctor</c>, accessors as <c>Type.Prop.get</c>).</summary>
    public static string Short(ISymbol symbol)
    {
        if (symbol is INamedTypeSymbol type)
        {
            return type.ToDisplayString(TypeFormat);
        }

        var container = symbol.ContainingType is null ? string.Empty : symbol.ContainingType.ToDisplayString(TypeFormat) + ".";
        return container + MemberName(symbol);
    }

    /// <summary>Fully qualified signature used in changedSymbols.</summary>
    public static string Full(ISymbol symbol) => symbol.ToDisplayString(FullFormat);

    public static string Kind(ISymbol symbol)
    {
        return symbol switch
        {
            IMethodSymbol m => m.MethodKind switch
            {
                MethodKind.Constructor => "constructor",
                MethodKind.StaticConstructor => "staticConstructor",
                MethodKind.Destructor => "destructor",
                MethodKind.UserDefinedOperator => "operator",
                MethodKind.Conversion => "conversion",
                MethodKind.PropertyGet => "getter",
                MethodKind.PropertySet => m.IsInitOnly ? "init" : "setter",
                MethodKind.EventAdd or MethodKind.EventRemove or MethodKind.EventRaise => "event",
                _ when m.Name == WellKnownMemberNames.TopLevelStatementsEntryPointMethodName => "entryPoint",
                _ => "method",
            },
            IPropertySymbol p => p.IsIndexer ? "indexer" : "property",
            IEventSymbol => "event",
            IFieldSymbol f => f.ContainingType?.TypeKind == TypeKind.Enum ? "enumMember" : "field",
            INamedTypeSymbol => "type",
            _ => symbol.Kind.ToString().ToLowerInvariant(),
        };
    }

    private static string MemberName(ISymbol symbol)
    {
        return symbol switch
        {
            IMethodSymbol { MethodKind: MethodKind.Constructor } => ".ctor",
            IMethodSymbol { MethodKind: MethodKind.StaticConstructor } => ".cctor",
            IMethodSymbol { MethodKind: MethodKind.PropertyGet or MethodKind.PropertySet, AssociatedSymbol: { } property } m =>
                PropertyName(property) + (m.MethodKind == MethodKind.PropertyGet ? ".get" : m.IsInitOnly ? ".init" : ".set"),
            IPropertySymbol p => PropertyName(p),
            _ => symbol.Name,
        };
    }

    private static string PropertyName(ISymbol property) => property is IPropertySymbol { IsIndexer: true } ? "this[]" : property.Name;
}
