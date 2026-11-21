# Wallet and payout demonstration

Start the app using the [local setup](../README.md#run-locally).

1. Select **Start demo**. The wallet shows 25,000 VEs, 5,000 SVEs, 100 Gems, 500 Tokens, and 3 Spins. The history contains the seeded credits.
2. Select **Redeem rewards**, choose **UPI**, and select **₹100**. The payout form shows 25,000 VEs available and 19,500 VEs required.
3. Select **Use sample UPI ID** to fill `demo@sample`. Select **Review withdrawal**, check the amount, cost, and destination, then confirm. The request appears as **Pending**.
4. Select **View wallet**. The balance is 5,500 VEs and the ledger has a UPI debit for 19,500 VEs.
5. Return to Payout and select **₹50**. The option costs 10,000 VEs, so the form shows insufficient funds and disables review.

If the connection drops during submission, use **Check status**. If the request is still unresolved, retry with the same details or choose **Discard attempt**. A committed debit returns its existing receipt.

## Test the API in Postman

Import the [Postman collection](VELoop-Wallet.postman_collection.json). Set `adminEmail` and `adminPassword` as private environment variables using the credentials you seeded. Run **Start demo** and **Administrator login** to populate the request variables.

| Scenario | Requests and expected result |
| --- | --- |
| Duplicate submission | Run **Submit withdrawal** and **Retry same withdrawal**. The responses have the same withdrawal ID and the ledger has one debit. |
| Rejection | Run **Reject withdrawal** on the pending request. **Get wallet** shows 25,000 VEs. **Get wallet transactions** includes a separate 19,500 VE credit and **Get withdrawal** includes a reason and refund transaction ID. |
| Approval | Run **Start demo** and **Submit withdrawal** to create a separate pending request. Run **Mark processing** and **Approve processing withdrawal**. The request is approved and 5,500 VEs remain. |
| Credit and debit | Start a fresh demo, run **Credit wallet**, then **Debit wallet**. Each posts 500 VEs. The balance goes from 25,000 to 25,500 and back to 25,000. |

Use **Get withdrawal review history** to inspect the status changes and **Reconcile wallet** to compare all five balances with their ledger entries.
