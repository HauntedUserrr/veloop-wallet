import { PayoutMethod, PayoutOption } from './models.js';

export async function seedCatalog() {
  const methods = [
    { _id: 'upi', name: 'UPI', active: true, detailType: 'UPI_ID', detailLabel: 'UPI ID', regions: ['IN'], order: 1 },
    { _id: 'paypal', name: 'PayPal', detailType: 'EMAIL', detailLabel: 'PayPal email address', order: 2 },
    { _id: 'amazon', name: 'Amazon Gift Card', detailType: 'EMAIL', detailLabel: 'Delivery email address', order: 3 },
    { _id: 'google_play', name: 'Google Play Gift Card', detailType: 'EMAIL', detailLabel: 'Delivery email address', order: 4 },
  ];
  await PayoutMethod.bulkWrite(methods.map(method => ({
    updateOne: { filter: { _id: method._id }, update: { $setOnInsert: { active: false, regions: [], ...method } }, upsert: true, timestamps: false },
  })));

  const tiers = [[10, 2400], [25, 5800], [50, 10000], [100, 19500], [150, 28500], [300, 52500], [500, 80500], [1000, 150000]];
  await PayoutOption.bulkWrite(tiers.map(([rupees, requiredAmount]) => {
    const _id = `upi_${rupees}`;
    return { updateOne: { filter: { _id }, update: { $setOnInsert: {
      _id, method: 'upi', currency: 'ves', requiredAmount, payoutMinor: rupees * 100,
      payoutCurrency: 'INR', active: true,
    } }, upsert: true, timestamps: false } };
  }));
}
