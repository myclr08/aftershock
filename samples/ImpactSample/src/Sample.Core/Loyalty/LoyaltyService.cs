using Sample.Core.Orders;

namespace Sample.Core.Loyalty;

public sealed class LoyaltyService
{
    public const int RedeemThreshold = 100;

    public bool CanRedeem(Customer customer)
    {
        return customer.LoyaltyPoints >= RedeemThreshold;
    }

    public void Reset(Customer customer)
    {
        customer.LoyaltyPoints = 0;
    }
}
