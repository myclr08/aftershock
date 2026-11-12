using Sample.Core.Orders;

namespace Sample.Core.Pricing;

public class PriceCalculator
{
    public decimal Subtotal(Order order)
    {
        decimal sum = 0;
        foreach (var line in order.Lines)
        {
            sum += line.UnitPrice * line.Quantity;
        }

        return sum;
    }

    // Tax is rounded to two decimals per order, not per line.
    public decimal Tax(Order order)
    {
        return Math.Round(Subtotal(order) * TaxRates.ForCountry(order.Customer.CountryCode), 2);
    }

    public decimal Total(Order order)
    {
        return Subtotal(order) + Tax(order);
    }
}
