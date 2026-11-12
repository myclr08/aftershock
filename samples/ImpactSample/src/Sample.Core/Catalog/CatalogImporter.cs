using System.Globalization;

namespace Sample.Core.Catalog;

public static class CatalogImporter
{
    // Reads "SKU;price" lines into a catalog.
    public static async Task<ProductCatalog> ImportAsync(TextReader reader)
    {
        var catalog = new ProductCatalog();
        string? line;
        while ((line = await reader.ReadLineAsync()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            var parts = line.Split(';');
            catalog.Add(parts[0].Trim(), decimal.Parse(parts[1], CultureInfo.InvariantCulture));
        }

        return catalog;
    }
}
