namespace Sample.Core.Pricing;

public static class TaxRates
{
    public static decimal ForCountry(string countryCode)
    {
        return countryCode switch
        {
            "DE" => 0.19m,
            "NL" => 0.21m,
            "TR" => 0.20m,
            _ => 0m,
        };
    }
}
