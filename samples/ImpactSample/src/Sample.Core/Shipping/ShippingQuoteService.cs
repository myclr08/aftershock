using Sample.Core.Orders;

namespace Sample.Core.Shipping;

public sealed class ShippingQuoteService
{
    public decimal Quote(ShippingMethod method, Order order)
    {
        return method.Cost(order);
    }

    public int Eta(ShippingMethod method, Order order)
    {
        return method.EstimatedDays(order);
    }
}
