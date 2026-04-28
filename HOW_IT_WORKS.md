# How Outlier Finder Works

Outlier Finder is a tool that identifies YouTube videos performing exceptionally well, outstripping the standard historical performance metrics of the channels that published them. This helps creators analyze viral patterns.

## The Process

1. **User Input:** 
   The user provides a keyword or phrasing that maps to a specific niche (e.g., "productivity setups") along with constraints such as upload timeframe and channel subscriber counts. 

2. **Waitlist & Registration:**  
   Users must sign in or register through a Google account. If a search is initiated prior to registration, the search is halted by a modal prompting authentication. 

3. **Bucket Target Videos:** 
   The platform connects securely to the YouTube API, extracting up to 50 videos matching the specified parameters. The data returned focuses on IDs, channel details, and timestamps.

4. **Filter Target Channels:** 
   Using the fetched channels, the app filters channels according to the user-specified minimum and maximum subscriber limits. Only compliant channels continue to the next step.

5. **Bucket Baseline Calculation Math Videos:** 
   The app retrieves the past 10 video uploads from each surviving channel, which will form the "baseline averages" for calculating outlier status.

6. **Fetch Full Statistics:** 
   The app queries updated view counts and other video statistics to create an up-to-date representation of channel performance for both the latest videos and the target channel content.

7. **Determine The Math (Outlier Score):**
   The True Outlier Score represents: _(Views from target video) / (Baseline average views of past 10 uploads)_. Those earning higher views than their channel averages achieve multiplier scores above 1x.

8. **Results:**
   Target videos are sorted in descending order according to their Outlier Scores. Results display the historical average comparison visually alongside export options to CSV format. 
