using Sample.Core.Orders;

namespace Sample.Core.Customers;

public static class CustomerFormatter
{
    public static string Describe(Customer customer)
    {
        return $"{customer.Id} ({customer.CountryCode}): {customer.LoyaltyPoints} points";
    }
}
