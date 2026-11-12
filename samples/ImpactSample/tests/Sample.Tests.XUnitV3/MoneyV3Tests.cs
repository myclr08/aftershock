using Sample.Core.Pricing;

namespace Sample.Tests.XUnitV3;

public class MoneyV3Tests
{
    public static TheoryData<decimal, decimal, decimal> Sums => new()
    {
        { 1m, 2m, 3m },
        { 0.5m, 0.25m, 0.75m },
    };

    [Theory]
    [MemberData(nameof(Sums))]
    public void Add_ReturnsSum(decimal left, decimal right, decimal expected)
    {
        Assert.Equal(new Money(expected, "EUR"), new Money(left, "EUR") + new Money(right, "EUR"));
    }

    // Generic class data attribute (xUnit v3).
    [Theory]
    [ClassData<CommutativeCases>]
    public void Add_IsCommutative(decimal left, decimal right)
    {
        Assert.Equal(new Money(left, "EUR") + new Money(right, "EUR"), new Money(right, "EUR") + new Money(left, "EUR"));
    }
}

public sealed class CommutativeCases : TheoryData<decimal, decimal>
{
    public CommutativeCases()
    {
        Add(5m, 2m);
        Add(1.25m, 0.75m);
    }
}
