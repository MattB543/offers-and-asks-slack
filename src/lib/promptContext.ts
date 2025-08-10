// Centralized, hardcoded context that is prepended to prompts for skill/tag extraction
// Replace the placeholder content below with the actual FLF Fellowship context

export const SKILL_EXTRACTION_CONTEXT = `
<fellowship-context>
This request is from an FLF fellow in the following context:

# Fellowship on AI for Human Reasoning

## Fellowship Details
**Applications Closed June 9th, 2025 | $25k–$50k stipend | 12 weeks, from July 14 - October 3**

*Join us in working out how to build a future which robustly empowers humans and improves decision-making.*

FLF's incubator fellowship will help talented researchers and builders start working on AI tools for coordination and epistemics. Participants will scope out and work on pilot projects, with discussion and guidance from experts. FLF provides:
- $25k–$50k stipend (depending on location and experience)
- Opportunity to work in shared SF Bay Area office or remotely
- Compute budget of $5,000
- Support potentially extending beyond fellowship period
- Help launching new organizations

[[Closed] Apply Now](https://jobs.lever.co/futureof-life/ffc752f2-a420-4c87-8c58-2212ae2e885c/apply)

### Why This Area?

The world is [radically underinvested in these beneficial applications](https://www.forethought.org/research/ai-tools-for-existential-security). High stakes and rapid changes mean decision-makers may be disoriented or fail to coordinate on necessary actions. AI tools could help everyone track the state of play, make decisions they stand behind, and act in sync with others.

### Who We're Looking For

- Want to use time to help humanity navigate transformative AI
- Happy thinking about fuzzy, complicated topics  
- Have "doer" mentality
- Technical, entrepreneurial, or domain-specific skills:
  - ML background
  - [HCI](https://en.wikipedia.org/wiki/Human%E2%80%93computer_interaction) research or building tools for thought
  - Engineering or product team experience
  - Startup founder/early employee experience
  - Strategy research or [distillation](https://distill.pub/2017/research-debt/) aptitude

**Err on the side of applying** - [reach out](mailto:fellowship@flf.org) with questions

### Timeline & Logistics

- Apply by June 9th, 2025 (applications by June 2nd appreciated)
- Interviews by June 18th
- Offers by June 24th
- Opens with in-person workshop, builds to "demo day" final week
- [Office hours May 29th, 9am PST / 5pm GMT](https://lu.ma/56kt9lzj)
- Remote participation welcome (except 3-day kickoff workshop)
- Cannot sponsor visas but can participate remotely
- Teams can apply (submit individual applications noting collaboration)

### Mentors

Anthony Aguirre, Andreas Stuhlmüller, Deger Turan, Eli Lifland, Jay Baxter, Josh Rosenberg, Julian Michael, Michiel Bakker, Owen Cotton-Barratt, Oly Sourbut, Ben Goldhaber

### Core Activities

**Roadmapping:**
- Exploring implications and desirability
- Technical requirements
- Societal adoption needs  
- Viable pathways
- Key uncertainties

**Prototyping:**
- [Living lab](https://en.wikipedia.org/wiki/Living_lab) philosophy: "co-creation, exploration, experimentation and evaluation in real life use cases"
- 'Going for the throat' - trying to actually solve problems reveals real challenges

---

# AI Applications for Existential Security

## Executive Summary

**Core Thesis:** AI progress is shaping the world, but we can influence which applications develop first. Like differential technological progress, we can shape AI's character to help navigate challenges.

**Key Insight (Liska):** "Even just getting a boost for a limited period of time, say between two GPT equivalents... that increase could be really valuable, especially as we're starting to really face serious challenges."

## Three Clusters of Beneficial AI Applications

### 1. Epistemic Applications
Help us understand the world better and avoid catastrophic decisions.

**Core Examples:**
- **AI Forecasting:** Better predictions about novel technological developments and strategic implications. Could align expectations between parties if sufficiently trusted.
- **Collective Epistemics/Sanity Tools:** 
  - Grade statements from pundits and produce track records
  - Fact-checking and verification systems
  - "Community notes for everything"
  - Always-on rhetoric highlighting to notice unsupported implicatures
- **Judgment Assistance:** Help people make good judgment calls, avoid emotional traps
- **Philosophy & Reasoning:** Tackle hard philosophical questions where errors might be subtle; help avoid moral catastrophes

**Implementation Strategies:**
- Create benchmarks showing "how much are people better informed after engaging with an AI tool"
- Focus on platform integration rather than standalone tools: "trying to help make the platforms and systems that already are being used...more epistemically sound"
- Use "time-stamped data" that's "not super connected to everything else" - even "developments in some tiny little city" to avoid contamination
- Collect "intermediate private outputs" from domain experts - their tacit knowledge

### 2. Coordination-Enabling Applications
Help different parties work together when local incentives prevent beneficial outcomes.

**Core Examples:**
- **Automated Negotiation:** 
  - Imagine Congress members with AI delegates knowing preferences/boundaries
  - Iterate through thousands of proposals rapidly
  - Find optimal compromises humans wouldn't discover
  - Relieve bandwidth issues, permit confidential processing of private information
- **Commitment Technologies & Treaty Verification:**
  - AI systems as trusted arms inspectors who won't leak sensitive information
  - Enforcement of treaty provisions
  - *Warning:* "if you can make credible commitments to do something illegal...we should be treating that as you have done the illegal thing"
- **Structured Transparency:**
  - Monitor that people aren't building weapons
  - Help developers understand model usage
  - No privacy issues of normal surveillance
- **Asymmetric Information Solutions:**
  - Journalist/source transaction with trusted AI intermediary
  - Evaluates story value while "forgetting" details

**Risks:** Tools could empower small cliques to gain power, enable extortion via credible threats, or "lock in" choices prematurely.

### 3. Risk-Targeted Applications
Directly address specific existential risks.

**Core Examples:**
- **AI for AI Safety/Alignment:**
  - Automating theoretical alignment, mechanistic interpretability, AI control
  - If automated early enough vs capabilities, could keep safety techniques current
  - "This could make the difference between 'It's functionally impossible to bring alignment up to the requisite standard in time' and 'this is just an issue of devoting enough compute to it'"
  - Modeling alignment impacts of weight updates for [smarter updates](https://blog.elicit.com/system-2-learning/) than blind gradient descent
- **Information Security:** 
  - Limit proliferation of powerful models
  - Reduce risk of rogue model self-exfiltration
  - Facilitate coordination to avoid racing
- **Biosecurity:**
  - Screening to prevent synthesis of pandemic viruses
  - AI-assisted biosurveillance for early detection
  - Pandemic Management Example: Highly customized contact tracing apps with personalized recommendations

## Methods for Accelerating Beneficial Applications

### Technical Approaches

**1. Data Pipeline & Task Grading:**
- Curate specialized datasets (e.g., datasets of identified decision-making errors)
- Share intermediate research products (working notes, conversations)
- Define robust task-evaluation schemes - "metrics tend to accelerate development"
- Collect domain expert tacit knowledge
- Build time-stamped, uncontaminated data for forecasting

**2. Post-Training Enhancements:**
- Fine-tuning on specialized data
- Better scaffolding and prompting
- Per Epoch research: 5-30x improvement possible through post-training alone

**3. Compute Allocation:**
- "A lot of the relative rate of progress...is basically determined by some people's decision about where to spend compute"
- As R&D automates, compute allocation increasingly determines progress rates
- Under inference paradigms, larger compute investment gives better performance

**4. Complementary Tech & UI:**
- Build better interfaces for specific users (e.g., policymakers)
- Create secure, privacy-preserving versions
- Address trust issues: "Maybe they don't trust the thing that currently exists"

### Social & Strategic Approaches

**"Hype is Underrated" Principle:**
- "Coming up with a name for some area...and then just use the name a lot on Twitter"
- Create conceptual categories making neglected applications feel inevitable
- Host conferences, offer prizes, build prototypes
- Advanced market commitments

**Bootstrap Strategy:**
- "You start making better progress on vaccine science now...that puts you in a better place for making even faster progress later"
- Choose applications that improve ability to build future applications

**Subject Matter Expert Engagement:**
- Get domain experts sharing actual experience with current AI tools
- Focus on specific high-value early adopters

## Critical Selection Criteria

### Under-Incentivized Public Goods
- Government/policymaker tools - "don't have a lot of funding"
- Cross-organizational coordination - no single actor captures enough value
- Monitoring/verification systems - classic public goods problem

### Timing Considerations
- Even small speed-ups crucial (e.g., switching order of risk-generating vs risk-reducing capabilities)
- Gap between AI capability milestones is when specialized applications matter most
- Minor differences could represent major capability level differences

### Project Evaluation Framework
1. Bottleneck timing: "thinking about where we can get derailed earlier on"
2. Veil of ignorance opportunities: Applications useful "when a broader set of people have bargaining power"
3. Compounding potential
4. Adoption readiness

## Why Speed Up Rather Than Slow Down?

1. **More collaborative:** Working with rather than against progress
2. **Avoids difficult tradeoffs:** Don't sacrifice beneficial applications
3. **Easier to implement:** "You can just do it yourself" - unilateral action possible vs requiring treaties
4. **Fewer enemies:** Building positive applications doesn't create opposition

## Current Market Dynamics & Scale of Opportunity

- AI capabilities often exist months before usable applications
- "The private efforts going into making AI applications are just very small"
- 80-90% of recent Y Combinator batch was AI startups, growing 5x faster
- Yet "the space of opportunities is so much richer than the set of opportunities that are being taken"
- Vision: 30% of x-risk focused people working on this near-term, 50% if AI progress continues

## Preparing for Cognitive Abundance

**Critical Mental Model Shift:**
"We've been doing a bunch of strategizing...trying to pick the strategies that will use the people we have as effectively as possible...But if AI is going to be boosting the amount of cognitive labor, that actually means that we do not have this constraint."

**Newly Viable Strategies:**
- Automatically propagating updates through knowledge databases
- Exploring massive spaces of potential solutions
- Processing rich information person-by-person for contact tracing
- "Crazy customization" and "real-time updating"

## Action Items

### For Individuals
**Immediate:**
- Use AI applications "even in situations where it's not really clear if it makes sense"
- Focus on automating core work, not just administrative tasks
- Document everything: "publishing more of your intermediate outputs"
- "Organize your tasks or basically delineate tasks that could get automated"
- Save all work artifacts: meeting notes, emails, rough drafts

**Network Building:**
- "Don't burn bridges with the people who you might want to coordinate with"
- Build relationships with potential users
- Connect with startup world if relevant

### For Domain Experts
- Share what applications would be most valuable
- Document tacit knowledge and intermediate work products
- Identify where current AI tools fall short

### For Builders
- Experiment with prototypes, even "weird" ones
- Talk to users about adoption barriers
- Focus on genuinely neglected applications

### For Strategists
- Develop concrete project proposals
- Think assuming abundant cognitive labor
- Identify closing windows of opportunity

## Strategic Warnings

### The Displacement Trap
"If you step in as your kind of impact-motivated investor, then what you're basically doing is just displacing some other investor who cares less about impact."

### Adoption Barriers
- "People are very hesitant to automate high-stakes...for good reason"
- Rogue Actor Dynamic: "Who is most willing to do the risky thing?...reckless...rogue actors"
- Creates pressure to help responsible actors adopt before irresponsible ones gain advantage

### The Bitter Lesson Caveat
Exceptions where specialized efforts matter:
- Applications with compounding effects
- Institutional lock-in opportunities
- Network effects in coordination tools

## 10-Year Retrospective Test

**Key Question:** "Why didn't we get started on this project sooner?"

**Likely Regrets:**
- Not shaping compute allocation early enough
- Letting legal/institutional barriers solidify
- Missing early bargaining windows
- Failing to build coalitions before positions hardened
- "We just fully missed the point where we lost a lot of the possible, like the window closed earlier than we were thinking"

## Key Open Questions

1. Which applications are "super important to get early"?
2. What does accelerating complex applications like AI philosophy research look like?
3. Negative effects: "The especially like coordination stuff, I'm a bit worried about"
4. What specifically prevents decision-makers from using available tools?
5. Which AI development paradigms should we favor?
6. Which approaches to speeding up applications actually work?

## Personal Applications Liska Wants
- AI that comments on Google Docs for writing feedback
- "Guardian angel" AI for self-control and habit formation
- Systems tracking behavior and providing nudges based on pre-committed goals

**Bottom Line:** AI will reshape the world. We can influence which applications come first and ensure beneficial uses aren't left behind while focusing solely on preventing harms. The opportunity is massive, timing is critical, and many more people should be working on this.
</fellowship-context>
`;
