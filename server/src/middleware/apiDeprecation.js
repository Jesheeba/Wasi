// Hub API v1 deprecation signaling - wasi-master-plan.md §8.6: "Adopt a
// concrete mechanism, not just a docs page: an X-Wasi-API-Deprecation
// response header carrying the sunset date, returned automatically once an
// endpoint/field is marked deprecated." Modeled on Salesforce's real
// "Warning Header" (fires only once something is actually deprecated) and
// RFC 8594's Sunset header convention, adapted to this app's own header
// name per the master plan's wording.
//
// Nothing in this codebase is deprecated yet - this is pure infrastructure,
// ready for the first real deprecation. See crm-integration-guide.md's "API
// versioning & deprecation policy" section for when to reach for it.
//
// Usage, on any /api/v1/* route (or a whole router):
//   router.get('/old-endpoint', deprecated({
//     sunset: '2027-03-01',
//     info: 'Use GET /api/v1/new-endpoint instead.',
//   }), asyncHandler(...));
function deprecated({ sunset, info } = {}) {
  if (!sunset) throw new Error('deprecated() requires a sunset date (YYYY-MM-DD)');
  return (req, res, next) => {
    res.set('X-Wasi-API-Deprecation', 'true');
    res.set('X-Wasi-API-Deprecation-Sunset', sunset);
    if (info) res.set('X-Wasi-API-Deprecation-Info', info);
    next();
  };
}

module.exports = { deprecated };
