using Sample.Core.Orders;

namespace Sample.Core.Shipping;

public sealed class ExpressShipping : ShippingMethod
{
    public override string Name => "Express";

    public override decimal Cost(Order order)
    {
        var items = order.Lines.Sum(line => line.Quantity);
        return items == 0 ? 0m : 14.99m + (items - 1);
    }

    public override int EstimatedDays(Order order)
    {
        return 1;
    }
}
