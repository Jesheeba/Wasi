// Curated content for the WhatsApp Template Message Library
// (wasi-master-plan.md §2). Pure data — no DB access, no side effects —
// imported by both seedTemplateLibrary.js (the actual seed script) and its
// test (server/test/templateLibraryContent.test.js), so the exact same
// content that gets inserted is what gets validated.
//
// SCOPE (Phase 2, this pass): 3 of the master plan's 8 minimum industries —
// E-commerce, Healthcare, General/Other — ~12 templates each, 36 total.
// Chosen because they're the industries the master plan itself gives the
// most concrete use-case guidance for (E-commerce's explicit 9-item list;
// Healthcare's "appointment reminder" example elsewhere in the plan) plus
// General/Other to house category-spanning utility content and the only
// Authentication entries in this batch. The remaining 5 industries
// (Education, Finance, Travel, Automobile, Events & Webinars) are deferred
// to a follow-up content batch using this exact same
// data-array + preflight-validation pattern — see the Phase 2 completion
// report for the plan.
//
// Deliberately excluded from this batch: any header_type other than
// 'NONE'/'TEXT'. An IMAGE/VIDEO/DOCUMENT header needs a real uploaded media
// asset at Meta-submission time (routes/templates.js's multer upload path)
// — the library has no mechanism to supply one, and building a shared
// media-asset store for library content is out of scope for this phase
// (see migration 036's comment).
//
// Every URL below is a placeholder domain (your-store.example.com etc.) —
// syntactically valid so it passes messageTemplateCreateSchema's
// z.string().url(), but a client MUST replace it with their own real URL
// before actually submitting to Meta. This is expected, not a bug: "Use
// this Template" prefills into the existing, fully-editable Create
// Template modal — nothing here is submitted as-is.

const ECOMMERCE = [
  {
    use_case: 'abandoned_cart',
    category: 'Marketing',
    title: 'Abandoned Cart Reminder',
    header: { type: 'TEXT', text: 'Still thinking it over?' },
    body: 'Hi {{customer_name}}, you left {{item_name}} in your cart. Complete your purchase now before it sells out.',
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'URL', text: 'Complete Purchase', url: 'https://your-store.example.com/cart' }],
    sample_values: { customer_name: 'Priya', item_name: 'Wireless Earbuds' },
  },
  {
    use_case: 'order_confirmation',
    category: 'Utility',
    title: 'Order Confirmation',
    header: { type: 'TEXT', text: 'Order Confirmed' },
    body: 'Hi {{customer_name}}, thanks for your order! Your order {{order_id}} for {{item_name}} has been confirmed and is being prepared.',
    footer: null,
    buttons: [{ type: 'QUICK_REPLY', text: 'Track Order' }],
    sample_values: { customer_name: 'Priya', order_id: '#4821', item_name: 'Wireless Earbuds' },
  },
  {
    use_case: 'shipping_update',
    category: 'Utility',
    title: 'Shipping Update',
    header: { type: 'TEXT', text: 'Your Order Has Shipped' },
    body: 'Good news, {{customer_name}}! Your order {{order_id}} has shipped and is on its way. Expected delivery: {{delivery_date}}.',
    footer: null,
    buttons: [{ type: 'URL', text: 'Track Shipment', url: 'https://your-store.example.com/track' }],
    sample_values: { customer_name: 'Priya', order_id: '#4821', delivery_date: 'August 30' },
  },
  {
    use_case: 'delivery_confirmation',
    category: 'Utility',
    title: 'Delivery Confirmation',
    header: { type: 'TEXT', text: 'Delivered!' },
    body: 'Hi {{customer_name}}, your order {{order_id}} was delivered today. We hope you love it! Let us know if anything is missing or damaged.',
    footer: null,
    buttons: null,
    sample_values: { customer_name: 'Priya', order_id: '#4821' },
  },
  {
    use_case: 'review_request',
    category: 'Marketing',
    title: 'Product Review Request',
    header: { type: 'TEXT', text: 'How Did We Do?' },
    body: 'Hi {{customer_name}}, we would love to hear your thoughts on {{item_name}}. Your feedback helps other shoppers and takes less than a minute.',
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'QUICK_REPLY', text: 'Leave a Review' }, { type: 'QUICK_REPLY', text: 'Not Now' }],
    sample_values: { customer_name: 'Priya', item_name: 'Wireless Earbuds' },
  },
  {
    use_case: 'restock_alert',
    category: 'Marketing',
    title: 'Back in Stock Alert',
    header: { type: 'TEXT', text: 'Back in Stock' },
    body: 'Hi {{customer_name}}, good news — {{item_name}} is back in stock! Order now before it runs out again.',
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'URL', text: 'Shop Now', url: 'https://your-store.example.com/shop' }],
    sample_values: { customer_name: 'Priya', item_name: 'Wireless Earbuds' },
  },
  {
    use_case: 'promotional_offer',
    category: 'Marketing',
    title: 'Seasonal Promotional Offer',
    header: { type: 'TEXT', text: 'A Special Offer for You' },
    body: 'Hi {{customer_name}}, enjoy {{discount_percent}} percent off your next order with code {{promo_code}}. Valid through {{expiry_date}}.',
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'URL', text: 'Shop the Sale', url: 'https://your-store.example.com/sale' }],
    sample_values: { customer_name: 'Priya', discount_percent: '15', promo_code: 'SAVE15', expiry_date: 'August 31' },
  },
  {
    use_case: 'cod_confirmation',
    category: 'Utility',
    title: 'Cash on Delivery Confirmation',
    header: { type: 'TEXT', text: 'Confirm Your Order' },
    body: 'Hi {{customer_name}}, please confirm your cash-on-delivery order {{order_id}} for {{amount}}. Reply YES to confirm or NO to cancel.',
    footer: null,
    buttons: [{ type: 'QUICK_REPLY', text: 'Yes, Confirm' }, { type: 'QUICK_REPLY', text: 'No, Cancel' }],
    sample_values: { customer_name: 'Priya', order_id: '#4821', amount: '₹1,299' },
  },
  {
    use_case: 'refund_processed',
    category: 'Utility',
    title: 'Refund Processed',
    header: { type: 'TEXT', text: 'Refund Processed' },
    body: 'Hi {{customer_name}}, your refund of {{amount}} for order {{order_id}} has been processed and should appear in your account within 5 to 7 business days.',
    footer: null,
    buttons: null,
    sample_values: { customer_name: 'Priya', amount: '₹1,299', order_id: '#4821' },
  },
  {
    use_case: 'order_cancelled',
    category: 'Utility',
    title: 'Order Cancellation Notice',
    header: { type: 'TEXT', text: 'Order Cancelled' },
    body: 'Hi {{customer_name}}, your order {{order_id}} has been cancelled as requested. Any payment made will be refunded within 5 to 7 business days.',
    footer: null,
    buttons: null,
    sample_values: { customer_name: 'Priya', order_id: '#4821' },
  },
  {
    use_case: 'price_drop_alert',
    category: 'Marketing',
    title: 'Price Drop Alert',
    header: { type: 'TEXT', text: 'Price Drop!' },
    body: 'Hi {{customer_name}}, the price of {{item_name}} just dropped to {{new_price}}. Grab it before the price changes again.',
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'URL', text: 'View Item', url: 'https://your-store.example.com/item' }],
    sample_values: { customer_name: 'Priya', item_name: 'Wireless Earbuds', new_price: '₹2,499' },
  },
  {
    use_case: 'welcome_new_customer',
    category: 'Utility',
    title: 'Welcome New Customer',
    header: { type: 'TEXT', text: 'Welcome!' },
    body: 'Hi {{customer_name}}, welcome to {{store_name}}! Your account is now active and ready to use. Reach out anytime if you need help getting started.',
    footer: null,
    buttons: [{ type: 'QUICK_REPLY', text: 'Start Shopping' }],
    sample_values: { customer_name: 'Priya', store_name: 'Wasi Store' },
  },
];

const HEALTHCARE = [
  {
    use_case: 'appointment_reminder',
    category: 'Utility',
    title: 'Appointment Reminder',
    header: { type: 'TEXT', text: 'Appointment Reminder' },
    body: 'Hi {{patient_name}}, this is a reminder for your appointment with {{doctor_name}} on {{appointment_date}} at {{appointment_time}}.',
    footer: null,
    buttons: [{ type: 'QUICK_REPLY', text: 'Confirm' }, { type: 'QUICK_REPLY', text: 'Reschedule' }],
    sample_values: { patient_name: 'Arjun', doctor_name: 'Dr. Mehta', appointment_date: 'August 30', appointment_time: '4:00 PM' },
  },
  {
    use_case: 'appointment_confirmation',
    category: 'Utility',
    title: 'Appointment Confirmation',
    header: { type: 'TEXT', text: 'Appointment Confirmed' },
    body: 'Hi {{patient_name}}, your appointment with {{doctor_name}} has been confirmed for {{appointment_date}} at {{appointment_time}}. Please arrive 10 minutes early.',
    footer: null,
    buttons: null,
    sample_values: { patient_name: 'Arjun', doctor_name: 'Dr. Mehta', appointment_date: 'August 30', appointment_time: '4:00 PM' },
  },
  {
    use_case: 'appointment_rescheduled',
    category: 'Utility',
    title: 'Appointment Rescheduled',
    header: { type: 'TEXT', text: 'Appointment Rescheduled' },
    body: 'Hi {{patient_name}}, your appointment with {{doctor_name}} has been moved to {{new_date}} at {{new_time}}. Please let us know if this new time does not work for you.',
    footer: null,
    buttons: null,
    sample_values: { patient_name: 'Arjun', doctor_name: 'Dr. Mehta', new_date: 'September 2', new_time: '5:30 PM' },
  },
  {
    use_case: 'appointment_cancelled',
    category: 'Utility',
    title: 'Appointment Cancellation Notice',
    header: { type: 'TEXT', text: 'Appointment Cancelled' },
    body: 'Hi {{patient_name}}, your appointment with {{doctor_name}} on {{appointment_date}} has been cancelled. Please contact us to schedule a new time.',
    footer: null,
    buttons: [{ type: 'PHONE_NUMBER', text: 'Call Clinic', phone_number: '+911234567890' }],
    sample_values: { patient_name: 'Arjun', doctor_name: 'Dr. Mehta', appointment_date: 'August 30' },
  },
  {
    use_case: 'lab_results_ready',
    category: 'Utility',
    title: 'Lab Results Ready',
    header: { type: 'TEXT', text: 'Results Ready' },
    body: 'Hi {{patient_name}}, your lab results from {{test_date}} are now ready. Please log in to your patient portal or contact us to review them.',
    footer: null,
    buttons: [{ type: 'URL', text: 'View Results', url: 'https://your-clinic.example.com/portal' }],
    sample_values: { patient_name: 'Arjun', test_date: 'August 25' },
  },
  {
    use_case: 'prescription_ready',
    category: 'Utility',
    title: 'Prescription Ready for Pickup',
    header: { type: 'TEXT', text: 'Prescription Ready' },
    body: 'Hi {{patient_name}}, your prescription for {{medicine_name}} is ready for pickup at {{pharmacy_name}}. Please bring a valid ID.',
    footer: null,
    buttons: null,
    sample_values: { patient_name: 'Arjun', medicine_name: 'Amoxicillin', pharmacy_name: 'City Pharmacy' },
  },
  {
    use_case: 'checkup_due_reminder',
    category: 'Utility',
    title: 'Annual Checkup Due Reminder',
    header: { type: 'TEXT', text: 'Time for a Checkup' },
    body: 'Hi {{patient_name}}, our records show your annual checkup is due. Book a convenient time with {{doctor_name}} to stay on top of your health.',
    footer: null,
    buttons: [{ type: 'QUICK_REPLY', text: 'Book Now' }],
    sample_values: { patient_name: 'Arjun', doctor_name: 'Dr. Mehta' },
  },
  {
    use_case: 'vaccination_reminder',
    category: 'Utility',
    title: 'Vaccination Reminder',
    header: { type: 'TEXT', text: 'Vaccination Due' },
    body: 'Hi {{patient_name}}, this is a reminder that your {{vaccine_name}} dose is due on {{due_date}}. Please book an appointment at your convenience.',
    footer: null,
    buttons: [{ type: 'QUICK_REPLY', text: 'Book Appointment' }],
    sample_values: { patient_name: 'Arjun', vaccine_name: 'Flu Vaccine', due_date: 'September 5' },
  },
  {
    use_case: 'billing_payment_due',
    category: 'Utility',
    title: 'Billing Payment Due',
    header: { type: 'TEXT', text: 'Payment Due' },
    body: 'Hi {{patient_name}}, your outstanding balance of {{amount}} for your recent visit is due by {{due_date}}. Please contact us if you have questions.',
    footer: null,
    buttons: [{ type: 'URL', text: 'Pay Now', url: 'https://your-clinic.example.com/pay' }],
    sample_values: { patient_name: 'Arjun', amount: '₹850', due_date: 'September 10' },
  },
  {
    use_case: 'telehealth_appointment_link',
    category: 'Utility',
    title: 'Telehealth Appointment Link',
    header: { type: 'TEXT', text: 'Video Consultation' },
    body: 'Hi {{patient_name}}, your video consultation with {{doctor_name}} starts at {{appointment_time}}. Join using the link below a few minutes early.',
    footer: null,
    buttons: [{ type: 'URL', text: 'Join Video Call', url: 'https://your-clinic.example.com/video' }],
    sample_values: { patient_name: 'Arjun', doctor_name: 'Dr. Mehta', appointment_time: '4:00 PM' },
  },
  {
    use_case: 'feedback_request',
    category: 'Marketing',
    title: 'Visit Feedback Request',
    header: { type: 'TEXT', text: 'How Was Your Visit?' },
    body: 'Hi {{patient_name}}, thank you for visiting us on {{visit_date}}. We would appreciate a moment of your time to share feedback on your experience.',
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'QUICK_REPLY', text: 'Share Feedback' }],
    sample_values: { patient_name: 'Arjun', visit_date: 'August 25' },
  },
  {
    use_case: 'health_tips_newsletter',
    category: 'Marketing',
    title: 'Monthly Health Tips',
    header: { type: 'TEXT', text: 'Your Monthly Health Tips' },
    body: 'Hi {{patient_name}}, here are this month’s health tips from {{clinic_name}} to help you stay well. Reply STOP anytime to opt out of these updates.',
    footer: 'Reply STOP to unsubscribe',
    buttons: null,
    sample_values: { patient_name: 'Arjun', clinic_name: 'Wasi Family Clinic' },
  },
];

const GENERAL = [
  {
    use_case: 'account_verification_otp',
    category: 'Authentication',
    title: 'Account Verification Code',
    // Authentication templates have no author-written body/header/footer —
    // Meta auto-generates the OTP message (metaClient.js's
    // buildAuthenticationPayload); this text is for the library's own
    // preview/browse UI only. "Use this Template" sets category to
    // 'Authentication' and deliberately does NOT prefill body/header/
    // footer/buttons into the creation form — the existing modal's own
    // Authentication-specific fields (codeExpirationMinutes, security
    // disclaimer, OTP button) take over from there.
    header: null,
    body: 'Your verification code is {{otp_code}}. For your security, do not share this code with anyone.',
    footer: null,
    buttons: null,
    sample_values: { otp_code: '482913' },
    auth_options: { codeExpirationMinutes: 10, addSecurityDisclaimer: true },
  },
  {
    use_case: 'login_verification_otp',
    category: 'Authentication',
    title: 'Login Verification Code',
    header: null,
    body: 'Use code {{otp_code}} to log in to your account. This code will expire shortly, so please use it right away.',
    footer: null,
    buttons: null,
    sample_values: { otp_code: '731045' },
    auth_options: { codeExpirationMinutes: 5, addSecurityDisclaimer: true },
  },
  {
    use_case: 'payment_link',
    category: 'Utility',
    title: 'Payment Link',
    header: { type: 'TEXT', text: 'Complete Your Payment' },
    body: 'Hi {{customer_name}}, please complete your payment of {{amount}} using the secure link below. This link expires on {{expiry_date}}.',
    footer: null,
    buttons: [{ type: 'URL', text: 'Pay Now', url: 'https://your-business.example.com/pay' }],
    sample_values: { customer_name: 'Ravi', amount: '₹2,500', expiry_date: 'August 31' },
  },
  {
    use_case: 'payment_received_confirmation',
    category: 'Utility',
    title: 'Payment Received Confirmation',
    header: { type: 'TEXT', text: 'Payment Received' },
    body: 'Hi {{customer_name}}, we have received your payment of {{amount}}. Thank you! A receipt has been sent to your registered email address.',
    footer: null,
    buttons: null,
    sample_values: { customer_name: 'Ravi', amount: '₹2,500' },
  },
  {
    use_case: 'event_registration_confirmation',
    category: 'Utility',
    title: 'Event Registration Confirmation',
    header: { type: 'TEXT', text: 'You’re Registered!' },
    body: 'Hi {{attendee_name}}, you are confirmed for {{event_name}} on {{event_date}}. We look forward to seeing you there.',
    footer: null,
    buttons: null,
    sample_values: { attendee_name: 'Ravi', event_name: 'Product Launch Meetup', event_date: 'September 12' },
  },
  {
    use_case: 'event_reminder',
    category: 'Utility',
    title: 'Event Reminder',
    header: { type: 'TEXT', text: 'Event Reminder' },
    body: 'Hi {{attendee_name}}, this is a reminder that {{event_name}} starts on {{event_date}} at {{event_time}}. See you soon!',
    footer: null,
    buttons: null,
    sample_values: { attendee_name: 'Ravi', event_name: 'Product Launch Meetup', event_date: 'September 12', event_time: '6:00 PM' },
  },
  {
    use_case: 'webinar_invite',
    category: 'Marketing',
    title: 'Webinar Invitation',
    header: { type: 'TEXT', text: 'You’re Invited' },
    body: 'Hi {{customer_name}}, join our upcoming webinar on {{topic}} on {{event_date}}. Seats are limited, so reserve yours today.',
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'URL', text: 'Reserve Your Seat', url: 'https://your-business.example.com/webinar' }],
    sample_values: { customer_name: 'Ravi', topic: 'Growing Your Business on WhatsApp', event_date: 'September 15' },
  },
  {
    use_case: 'customer_support_followup',
    category: 'Utility',
    title: 'Support Ticket Follow-Up',
    header: { type: 'TEXT', text: 'Following Up on Your Request' },
    body: 'Hi {{customer_name}}, we are following up on your support request {{ticket_id}}. Please let us know if the issue has been resolved to your satisfaction.',
    footer: null,
    buttons: [{ type: 'QUICK_REPLY', text: 'Resolved' }, { type: 'QUICK_REPLY', text: 'Still Need Help' }],
    sample_values: { customer_name: 'Ravi', ticket_id: '#7734' },
  },
  {
    use_case: 'subscription_renewal_reminder',
    category: 'Utility',
    title: 'Subscription Renewal Reminder',
    header: { type: 'TEXT', text: 'Renewal Coming Up' },
    body: 'Hi {{customer_name}}, your {{plan_name}} subscription renews on {{renewal_date}} for {{amount}}. No action is needed if you would like it to continue.',
    footer: null,
    buttons: null,
    sample_values: { customer_name: 'Ravi', plan_name: 'Pro', renewal_date: 'September 1', amount: '₹999' },
  },
  {
    use_case: 'subscription_expired',
    category: 'Utility',
    title: 'Subscription Expired Notice',
    header: { type: 'TEXT', text: 'Subscription Expired' },
    body: 'Hi {{customer_name}}, your {{plan_name}} subscription has expired. Renew now to continue enjoying uninterrupted access to your account.',
    footer: null,
    buttons: [{ type: 'URL', text: 'Renew Now', url: 'https://your-business.example.com/renew' }],
    sample_values: { customer_name: 'Ravi', plan_name: 'Pro' },
  },
  {
    use_case: 'seasonal_greeting',
    category: 'Marketing',
    title: 'Seasonal Greeting',
    header: { type: 'TEXT', text: 'Season’s Greetings' },
    body: 'Hi {{customer_name}}, wishing you a wonderful {{occasion}} from all of us at {{business_name}}. Thank you for being a valued customer this year.',
    footer: 'Reply STOP to unsubscribe',
    buttons: null,
    sample_values: { customer_name: 'Ravi', occasion: 'New Year', business_name: 'Wasi' },
  },
  {
    use_case: 'survey_request',
    category: 'Marketing',
    title: 'Customer Survey Request',
    header: { type: 'TEXT', text: 'We Value Your Opinion' },
    body: 'Hi {{customer_name}}, we would love your feedback in a short survey about your recent experience with {{business_name}}. It takes about two minutes.',
    footer: 'Reply STOP to unsubscribe',
    buttons: [{ type: 'URL', text: 'Take the Survey', url: 'https://your-business.example.com/survey' }],
    sample_values: { customer_name: 'Ravi', business_name: 'Wasi' },
  },
];

const TEMPLATE_LIBRARY_CONTENT = [
  ...ECOMMERCE.map((t) => ({ ...t, industry: 'E-commerce' })),
  ...HEALTHCARE.map((t) => ({ ...t, industry: 'Healthcare' })),
  ...GENERAL.map((t) => ({ ...t, industry: 'General/Other' })),
];

module.exports = { TEMPLATE_LIBRARY_CONTENT, ECOMMERCE, HEALTHCARE, GENERAL };
