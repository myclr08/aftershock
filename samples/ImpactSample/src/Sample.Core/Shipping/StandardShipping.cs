using Sample.Core.Orders;

namespace Sample.Core.Shipping;

public sealed class StandardShipping : ShippingMethod
{
    public override string Name => "Standard";

    public override decimal Cost(Order order)
    {
        return order.Lines.Count == 0 ? 0m : 4.99m;
    }
}
