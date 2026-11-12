namespace Sample.Core.Orders;

public sealed class Customer
{
    private int _loyaltyPoints;

    public Customer(string id, string countryCode)
    {
        Id = id;
        CountryCode = countryCode;
    }

    public string Id { get; }

    public string CountryCode { get; }

    public int LoyaltyPoints
    {
        get
        {
            return _loyaltyPoints;
        }
        set
        {
            _loyaltyPoints = Math.Max(0, value);
        }
    }
}
