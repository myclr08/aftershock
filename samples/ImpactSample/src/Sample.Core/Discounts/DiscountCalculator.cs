namespace Sample.Core.Discounts;

public static class DiscountCalculator
{
    public static decimal ApplyPercent(decimal amount, decimal percent)
    {
        return Math.Round(amount * (1 - (percent / 100m)), 2);
    }

    public static decimal ApplyFlat(decimal amount, decimal flat)
    {
        return Math.Max(0m, amount - flat);
    }

    public static decimal ApplyCoupon(decimal amount, string code)
    {
        return code switch
        {
            "WELCOME10" => ApplyPercent(amount, 10m),
            "FIVEOFF" => ApplyFlat(amount, 5m),
            _ => amount,
        };
    }
}
