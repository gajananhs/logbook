/* LOGBOOK settings — the only file you need to edit to tailor the app.
 * Leave a value empty to switch that feature off or let the user choose at send time. */
window.LOGBOOK_CONFIG = {
  // Pre-filled "To" address(es) for "Email summary" and "Send via email" (comma-separated).
  // Empty = the compose window opens with no recipient.
  summaryEmailTo: '',

  // WhatsApp number for "Share via WhatsApp", digits only with country code (e.g. '919876543210').
  // Empty = WhatsApp asks who to send it to.
  whatsappNumber: '',

  // Address of the Sales Report app. "Back to Sales Report" (on the More page and in the
  // header) opens it. Empty = the link is hidden for everyone.
  salesReportUrl: 'https://canaresonline.com/Salesreport/index.php',

  // Who sees "Back to Sales Report": every admin, plus anyone whose department or
  // sub-department name contains one of these words (capital letters don't matter).
  salesReportDepartments: ['marketing', 'ceo']
};
