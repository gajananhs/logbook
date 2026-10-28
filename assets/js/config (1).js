/* LOGBOOK settings — the only file you need to edit to tailor the app.
 * Leave a value empty to switch that feature off or let the user choose at send time. */
window.LOGBOOK_CONFIG = {
  // Live data: the Hostinger Logbook API. Every task, update, clock-in and employee change is read
  // from and saved to the same MySQL database the Hostinger dashboard uses — no exports, no per-device
  // copies. Empty = single-device demo mode (data kept only in this browser).
  apiUrl: 'https://canaresonline.com/logbook/api',
  // How often an open app pulls fresh data from the server (seconds).
  refreshSeconds: 30,

  // "Email summary" (Team board): address of the Logbook server's send_summary endpoint. The server
  // builds the formatted Team Summary from its own live data and emails it to the recipients set
  // on the server. Empty = open a compose window with a plain-text summary instead.
  summaryApiUrl: 'https://canaresonline.com/logbook/api/send_summary.php',

  // Who receives the summary. Shown in the confirmation message, and pre-filled as the "To"
  // address for "Send via email" on reports (comma-separated).
  summaryEmailTo: 'ecommerce@canares.com, gajanan@canares.com',

  // WhatsApp number for "Share via WhatsApp", digits only with country code (e.g. '919876543210').
  // Empty = WhatsApp asks who to send it to.
  whatsappNumber: '',

  // Address of the Sales Report app. "Back to Sales Report" (on the More page and in the
  // header) opens it. Empty = the link is hidden for everyone.
  salesReportUrl: 'https://canaresonline.com/Salesreport1/index.php',

  // Who sees "Back to Sales Report": every admin, plus anyone whose department or
  // sub-department name contains one of these words (capital letters don't matter).
  salesReportDepartments: ['marketing', 'ceo'],

  // Clock-in geofence: employees can clock in only when their phone's GPS puts them within
  // radiusMeters of this point. Keep in sync with OFFICE_LAT / OFFICE_LNG / OFFICE_RADIUS_M
  // in api/clock_in.php. Set lat to null to switch the check off.
  officeLocation: {
    name: 'Canares Automation Pvt. Ltd., Plot No. 85, Industrial Suburb, Yeshwanthpur, Bengaluru 560022',
    lat: 13.0220838,
    lng: 77.5435231,
    radiusMeters: 500
  }
};
