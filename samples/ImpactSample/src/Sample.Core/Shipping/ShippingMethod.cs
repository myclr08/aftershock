using Sample.Core.Orders;

namespace Sample.Core.Shipping;

public abstract class ShippingMethod
{
    public abstract string Name { get; }

    public abstract decimal Cost(Order order);

    public virtual int EstimatedDays(Order order)
    {
        return 5;
    }
}
