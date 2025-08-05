There is a bug in your analytics code that will cause a runtime error if it's ever executed.

#### Where the Code is Incorrect

The `getWeeklyStats` method in `src/services/matching.ts` attempts to query a table named `helper_suggestions`. This table is not defined in your schema or anywhere else.

```typescript
// src/services/matching.ts - The INCORRECT code

// ...
// Get average match scores for this week's suggestions
// THIS QUERY WILL FAIL. The `helper_suggestions` table is not defined.
/*
      const avgScoreResult = await db.query(`
        SELECT AVG(similarity_score) as avg_score 
        FROM helper_suggestions hs 
        JOIN weekly_needs wn ON hs.need_id = wn.id 
        WHERE wn.week_start = $1
      `, [weekStart]);
      */
// ...
```

The code is already commented out, which is good, but the surrounding logic still assumes it might exist.

#### The Fix: Remove the Dead Code

To prevent future errors, you should clean this up and ensure the function returns a valid, if incomplete, response.

**Action:** In `src/services/matching.ts`, ensure the query is removed and the return value is stable. The current code already does this by returning `averageMatchScore: 0`, which is correct. You should be aware of this incomplete feature.

By addressing these three issues, your application will be able to deploy and run successfully. The SSL fix will unblock the deployment, and the schema and service fixes will prevent subsequent crashes.
