'use strict';

// Origin's blueprint library: data, not code. A template names categories and the sections in them: built-in
// sections (Requirements, Architecture, Security…), shared modules (APIs & Integrations, Quality attributes) and
// sections of its own with guiding questions and starter blocks (checklists of building blocks to consider, tables to
// fill, flow skeletons). Applying one gives the project its own copy (see PromptboardOriginModel.blueprintFromTemplate):
// later versions of a template never change a project, and every category, section and field stays editable.
// Templates ask questions and suggest what to consider; they never choose a technology or make a decision.
globalThis.PromptboardOriginTemplates = (() => {
  const VERSION = 1;
  const CATEGORIES = [['web', 'Web'], ['apps', 'Applications'], ['ai', 'AI'], ['data', 'Data'], ['infrastructure', 'Infrastructure'], ['tools', 'Developer Tools']];
  const S = (key, title, description, questions = [], blocks = []) => ({ key, title, description, questions, blocks });
  const check = (title, items) => ({ type: 'checklist', title, checks: items });
  const table = (title, columns) => ({ type: 'table', title, columns });
  /** A flow skeleton: steps in order, each joined to the next unless `edges` ([from, to, label]) says otherwise. */
  const flow = (title, steps, edges) => ({ type: 'flow', title, nodes: steps.map((label, index) => ({ ref: `s${index}`, label })),
    edges: (edges || steps.slice(1).map((_, index) => [index, index + 1])).map(([from, to, label = '']) => ({ from: `s${from}`, to: `s${to}`, label })) });
  const phases = items => check('Suggested phases', items);

  // ---- Shared planning modules. Most are Origin's built-in sections under a clearer name; two are sections of their own. ----
  const MODULES = {
    overview: { section: 'vision', title: 'Objectives & Scope' },
    requirements: { section: 'requirements', title: 'Requirements & User Stories', questions: ['Who are the primary users, and what are their top three jobs to be done?', 'Which user stories make up the first usable release?'] },
    quality: { title: 'Quality Attributes', description: 'Functional and non-functional requirements that shape the architecture: performance, availability, scalability, security, accessibility, maintainability.',
      questions: ['Which quality attributes matter most for this project, in order?', 'What are the measurable targets (latency, uptime, throughput, error budget) and where are they measured?', 'Which regulatory or contractual requirements apply?'],
      blocks: [table('Quality attribute scenarios', ['Attribute', 'Scenario', 'Target', 'How it is measured'])] },
    architecture: { section: 'architecture', title: 'Architecture & Design' },
    technology: { section: 'technology', title: 'Technology Choices' },
    components: { section: 'dependencies', title: 'Components & Dependencies' },
    data: { section: 'data', title: 'Data Models & Storage' },
    apis: { title: 'APIs & Integrations', description: 'Interfaces this system offers and consumes: style, contracts, authentication, versioning and limits. API-first: agree on the contract before building against it.',
      questions: ['Which APIs does the system expose, to whom, and in which style (REST, GraphQL, gRPC, events)?', 'Which external systems does it integrate with, and who owns each contract?', 'How are contracts described (for example OpenAPI or AsyncAPI) and versioned?', 'What rate limits, timeouts and retry rules apply on each side?'],
      blocks: [table('Interfaces', ['Interface', 'Direction', 'Style', 'Consumers / provider', 'Auth', 'Versioning'])] },
    security: { section: 'security', title: 'Security, Privacy & Permissions' },
    testing: { section: 'testing', title: 'Testing & Quality Assurance' },
    delivery: { section: 'deployment', title: 'CI/CD, Deployment & Infrastructure' },
    observability: { section: 'observability', title: 'Monitoring & Reliability' },
    ai: { section: 'ai', title: 'AI / Agents' },
    decisions: { section: 'decisions', title: 'Architecture Decisions' },
    risks: { section: 'research', title: 'Risks, Assumptions & Open Questions' },
    roadmap: { section: 'plan', title: 'Milestones & Tasks' },
  };
  const C4 = flow('System context (C4 level 1)', ['People who use it', 'This system', 'External systems'], [[0, 1, 'use'], [1, 2, 'depends on']]);
  const REF = {
    asvs: ['OWASP Application Security Verification Standard', 'https://owasp.org/www-project-application-security-verification-standard/'],
    top10: ['OWASP Top 10', 'https://owasp.org/www-project-top-ten/'],
    llm: ['OWASP Top 10 for LLM Applications', 'https://genai.owasp.org/llm-top-10/'],
    masvs: ['OWASP Mobile Application Security (MASVS)', 'https://mas.owasp.org/MASVS/'],
    openapi: ['OpenAPI Specification', 'https://spec.openapis.org/oas/latest.html'],
    asyncapi: ['AsyncAPI Specification', 'https://www.asyncapi.com/docs/reference/specification/latest'],
    otel: ['OpenTelemetry documentation', 'https://opentelemetry.io/docs/'],
    c4: ['The C4 model', 'https://c4model.com/'],
    mcp: ['Model Context Protocol specification', 'https://modelcontextprotocol.io/specification/latest'],
    wcag: ['WCAG 2.2', 'https://www.w3.org/TR/WCAG22/'],
    vitals: ['Web Vitals', 'https://web.dev/articles/vitals'],
    pwa: ['Progressive Web Apps', 'https://web.dev/explore/progressive-web-apps'],
    twelve: ['The Twelve-Factor App', 'https://12factor.net/'],
    ssdf: ['NIST Secure Software Development Framework (SP 800-218)', 'https://csrc.nist.gov/projects/ssdf'],
    slsa: ['SLSA supply-chain levels', 'https://slsa.dev/'],
    semver: ['Semantic Versioning', 'https://semver.org/'],
    cncf: ['CNCF Cloud Native Landscape', 'https://landscape.cncf.io/'],
    k8s: ['Kubernetes documentation', 'https://kubernetes.io/docs/'],
    sre: ['Google SRE book: Service Level Objectives', 'https://sre.google/sre-book/service-level-objectives/'],
    mlops: ['Google Cloud: MLOps continuous delivery and automation pipelines', 'https://cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning'],
    nistai: ['NIST AI Risk Management Framework', 'https://www.nist.gov/itl/ai-risk-management-framework'],
    pci: ['PCI Security Standards', 'https://www.pcisecuritystandards.org/'],
    webext: ['MDN: Browser extensions', 'https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions'],
    clig: ['Command Line Interface Guidelines', 'https://clig.dev/'],
    iotsec: ['OWASP IoT Project', 'https://owasp.org/www-project-internet-of-things/'],
    crdt: ['CRDT resources', 'https://crdt.tech/'],
    openlineage: ['OpenLineage specification', 'https://openlineage.io/docs/'],
  };
  const refs = keys => keys.map(key => ({ title: REF[key][0], url: REF[key][1] }));
  /**
   * A template: `pool` holds its sections as written (shared module names and sections of its own), `layout` the
   * categories they go into, in order. Every pooled section must be placed exactly once.
   */
  function T(id, name, category, summary, description, { pool, layout, ...body }) {
    const sections = new Map(pool.flat().map(ref => [typeof ref === 'string' ? ref : ref.key, ref]));
    const placed = layout.flatMap(([, keys]) => keys);
    if (placed.length !== sections.size || placed.some(key => !sections.has(key))) throw new Error(`Template ${id}: every section must be placed once.`);
    return { id, version: VERSION, name, category, summary, description, ...body, categories: layout.map(([title, keys]) => ({ title, sections: keys.map(key => sections.get(key)) })), references: refs(body.references || []) };
  }

  const TEMPLATES = [
    T('frontend-web', 'Frontend Web Application / PWA', 'web', 'A browser app or installable PWA: UI architecture, state, accessibility and performance.',
      'For applications that run in the browser, from single-page apps to installable Progressive Web Apps. Focuses on how the interface is structured, how state and data flow, and how the app stays accessible, fast and reliable on real devices.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Experience', ['ui-architecture', 'routing-state', 'accessibility']], ['Performance & Delivery', ['performance', 'delivery', 'observability']], ['Build & Integrate', ['architecture', 'technology', 'apis', 'security', 'testing']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('ui-architecture', 'UI Architecture', 'How the interface is built: rendering model, layout, design system and component structure.',
              ['Which rendering model fits — client-rendered, server-rendered, static, or a mix — and why?', 'How are pages, layouts and components organised so teams can work in parallel?', 'Is there a design system or component library, and who owns it?'],
              [check('Building blocks to consider', ['App shell and layouts', 'Design system / component library', 'Router', 'State and data-fetching layer', 'API client', 'Service worker', 'Error boundaries and empty states', 'Analytics and consent'])]),
            S('routing-state', 'Routing & State', 'Navigation, global and local state, server data caching and forms.',
              ['How are routes defined, lazy-loaded and protected by sign-in or roles?', 'Which state is global, which is server data cached on the client, which lives in the URL, and which stays local?', 'How is data fetched, cached, invalidated and kept consistent after edits?', 'How do forms validate, show errors and recover from failed submissions?']),
            S('accessibility', 'Accessibility & Responsive Design', 'Who can use the app, on which screens and with which inputs.',
              ['Which WCAG conformance level is the target, and how is it verified before release?', 'Which screen sizes, input methods (touch, keyboard, screen reader) and browsers must work?', 'How are focus order, contrast, motion preferences and live updates handled?'],
              [check('Accessibility checks', ['Every action works with the keyboard', 'Focus is visible and moves sensibly', 'Images and icons have text alternatives', 'Colour contrast meets the target level', 'Form labels and errors are announced', 'Reduced-motion preference is respected'])]),
            S('performance', 'Performance & Offline', 'Load speed, responsiveness, bundle size and what works without a network.',
              ['What are the Core Web Vitals targets (LCP, INP, CLS), on which devices and networks?', 'What is the JavaScript budget, and how is code split and loaded?', 'Which assets and data does the service worker cache, and how are updates rolled out to installed apps?', 'What does the user see offline and when the connection returns?'],
              [table('Performance budget', ['Metric', 'Target', 'Device / network', 'How measured'])]),
          ],
          ['architecture', 'technology', 'apis', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { security: ['authentication', 'authorization', 'input_validation', 'data_sensitivity', 'secrets', 'supply_chain'], testing: ['unit', 'integration', 'e2e', 'performance', 'acceptance'],
          deployment: ['environments', 'hosting', 'configuration', 'ci_cd'], observability: ['logs', 'metrics', 'alerts', 'dashboards'] },
        questions: { testing: ['Which browsers and versions are supported, and how are they tested?', 'How are visual and accessibility regressions caught before release?'], observability: ['How are client-side errors and real-user performance collected, with consent?'] },
        blocks: { plan: [phases(['Clickable prototype of the main flow', 'Walking skeleton deployed end to end', 'Core flows built and accessibility-checked', 'Performance and offline hardening', 'Launch and real-user monitoring'])] },
        research: ['Rendering strategies (client, server, static, streaming) for this kind of app', 'Current PWA capabilities and browser support (installability, push, background sync)', 'WCAG 2.2 success criteria that affect the main flows', 'Core Web Vitals thresholds and how to measure them in the field', 'State management and data-fetching approaches and their trade-offs'],
        references: ['wcag', 'vitals', 'pwa', 'asvs', 'top10'] }),

    T('saas', 'Full-Stack SaaS Platform', 'web', 'A multi-tenant product with accounts, billing, roles and a web front end.',
      'For subscription software used by many organisations at once. Covers the full stack plus what makes SaaS different: tenancy and isolation, identity and roles, plans and billing, onboarding and the operational work of running one system for many customers.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Tenancy & Identity', ['tenancy', 'identity', 'security']], ['Plans & Customers', ['billing', 'onboarding']], ['Platform Engineering', ['architecture', 'technology', 'data', 'apis', 'testing', 'delivery', 'observability']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('tenancy', 'Multi-Tenancy & Isolation', 'How customers share the system and how their data stays apart.',
              ['Which tenancy model fits — shared tables with a tenant key, a schema per tenant, a database per tenant, or a mix — and why?', 'How is tenant isolation enforced in every query, cache, file store and background job?', 'How are noisy tenants contained (quotas, rate limits, separate capacity)?', 'Do any customers need data residency or a dedicated deployment?'],
              [table('Isolation per layer', ['Layer', 'How tenants are separated', 'How it is tested'])]),
            S('identity', 'Identity, Roles & Access', 'Sign-up, sign-in, organisations, invitations, roles and enterprise SSO.',
              ['How do people sign up, sign in and recover access?', 'How are organisations, members, invitations and roles modelled?', 'Which permissions exist, and are they role-based, attribute-based or per resource?', 'Which enterprise needs apply (SAML/OIDC single sign-on, SCIM provisioning, audit logs)?']),
            S('billing', 'Plans, Subscriptions & Billing', 'What customers pay for and how usage, limits and invoices work.',
              ['Which plans and limits exist, and what is metered?', 'How are trials, upgrades, downgrades, cancellations and failed payments handled?', 'Which billing provider responsibilities stay outside the system, and which records are kept here?', 'How are plan limits enforced consistently across the product?'],
              [table('Plans', ['Plan', 'Price model', 'Limits', 'Features'])]),
            S('onboarding', 'Onboarding & Lifecycle', 'From first visit to an active, retained customer — and offboarding.',
              ['What must a new organisation do before it gets value, and how short can that be?', 'Which emails and in-product messages are sent, and how can users control them?', 'How are account deletion and data export handled when a customer leaves?']),
          ],
          ['architecture', 'technology', 'data', 'apis', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { data: ['schemas', 'storage', 'retention', 'privacy', 'ownership'], deployment: ['environments', 'infrastructure', 'configuration', 'secrets', 'scaling', 'backups', 'recovery', 'ci_cd'] },
        questions: { security: ['How is a request from one tenant prevented from reading another tenant’s data, and how is that tested?'], testing: ['How are tenant isolation and plan limits covered by automated tests?'] },
        blocks: { architecture: [check('Building blocks to consider', ['Web front end', 'API / backend', 'Identity and access', 'Tenant-aware data layer', 'Billing integration', 'Background jobs', 'Email and notifications', 'Admin console', 'Audit log'])], plan: [phases(['Single-tenant walking skeleton', 'Identity, organisations and roles', 'Tenant isolation verified', 'Plans and billing', 'Onboarding and admin tooling', 'Beta customers'])] },
        research: ['Multi-tenant data isolation patterns and their trade-offs', 'Enterprise identity requirements (SSO, SCIM, audit)', 'Subscription billing models and provider capabilities', 'Data residency and privacy obligations for the target markets', 'SaaS reliability and SLO practices'],
        references: ['asvs', 'twelve', 'sre', 'openapi', 'otel'] }),

    T('backend-api', 'Backend API / Service', 'web', 'An API or service: contracts, endpoints, business logic, data and reliability.',
      'For services consumed by other software: public APIs, internal services and backends for apps. Starts from the contract, then covers business rules, data, authentication, caching, failure handling and how the API evolves without breaking its consumers.', {
        layout: [['Consumers & Contract', ['overview', 'requirements', 'contract', 'quality']], ['Domain & Data', ['domain', 'data']], ['Service Runtime', ['reliability', 'architecture', 'technology', 'components', 'security']], ['Operations', ['testing', 'delivery', 'observability']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('contract', 'API Contract', 'The interface consumers rely on: resources, operations, errors and versioning.',
              ['Who are the consumers, and what do they need first?', 'Which style fits the consumers — REST, GraphQL, gRPC, or events — and why?', 'How is the contract written and reviewed before implementation (for example OpenAPI)?', 'How are errors, pagination, filtering and idempotency expressed consistently?', 'How are versions introduced and old ones deprecated?'],
              [table('Endpoints / operations', ['Operation', 'Purpose', 'Request', 'Response', 'Auth', 'Idempotent'])]),
            S('domain', 'Business Logic & Domain Model', 'The rules the service enforces and the concepts it manages.',
              ['What are the core domain concepts and their invariants?', 'Which operations must be transactional, and which can be eventually consistent?', 'Where does validation live, and which rules are shared with clients?']),
            S('reliability', 'Caching, Limits & Reliability', 'How the service stays fast and correct under load and partial failure.',
              ['What can be cached, where, for how long, and how is it invalidated?', 'Which rate limits and quotas protect the service and its dependencies?', 'How are timeouts, retries, circuit breakers and back-pressure applied to downstream calls?', 'What happens to in-flight work during deploys and crashes?']),
          ],
          ['architecture', 'technology', 'data', 'components', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { testing: ['unit', 'integration', 'contract', 'security', 'performance', 'acceptance'], observability: ['logs', 'metrics', 'traces', 'alerts', 'slos', 'health_checks'] },
        questions: { testing: ['How are consumer contracts verified so a change cannot break a client unnoticed?'], security: ['Which OWASP API Security risks apply, and how is each mitigated?'] },
        blocks: { architecture: [C4], plan: [phases(['Contract drafted and reviewed with consumers', 'Walking skeleton with one endpoint end to end', 'Core operations with validation and errors', 'Reliability: limits, caching, timeouts', 'Versioning and deprecation policy published'])] },
        research: ['API style trade-offs for the known consumers', 'OpenAPI tooling for contract-first development', 'Idempotency, pagination and error-format conventions', 'Rate limiting and resilience patterns', 'OWASP API Security Top 10'],
        references: ['openapi', 'asvs', 'otel', 'sre', 'twelve'] }),

    T('microservices', 'Microservices & Event-Driven Architecture', 'infrastructure', 'Several services and events: boundaries, messaging, consistency and resilience.',
      'For systems split into independently deployed services that communicate through APIs and events. Emphasises service boundaries, event design, data ownership, distributed consistency, resilience and the observability needed to run it.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Service Design', ['boundaries', 'architecture', 'technology', 'apis', 'data']], ['Events & Consistency', ['events', 'consistency']], ['Resilience & Operations', ['resilience', 'security', 'testing', 'delivery', 'observability']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('boundaries', 'Service Boundaries', 'Which services exist, what each owns, and why it is separate.',
              ['Which business capabilities or bounded contexts define the services?', 'Which data does each service own, and who may read or change it?', 'Why is each boundary worth a network hop — or should some stay in one deployable?'],
              [table('Services', ['Service', 'Owns (data / capability)', 'Team', 'Exposes', 'Depends on'])]),
            S('events', 'Events & Messaging', 'The events services publish and consume, and the messaging that carries them.',
              ['Which events exist, who publishes and who consumes each, and how are they described (for example AsyncAPI)?', 'Which delivery guarantees are needed (at-least-once, ordering, deduplication)?', 'How are event schemas versioned without breaking consumers?', 'Where are commands used instead of events, and why?'],
              [table('Event catalogue', ['Event', 'Producer', 'Consumers', 'Key', 'Schema version'])]),
            S('consistency', 'Distributed Transactions & Consistency', 'How business processes that span services stay correct.',
              ['Which processes span several services, and what must hold at the end of each?', 'Which pattern fits each — saga (orchestrated or choreographed), outbox, compensation?', 'How are duplicate, late and out-of-order messages handled?'],
              [flow('Example saga (edit to a real process)', ['Start request', 'Service A step', 'Service B step', 'Complete or compensate'])]),
            S('resilience', 'Resilience & Orchestration', 'How the system degrades and recovers, and how services are deployed and discovered.',
              ['How do timeouts, retries, bulkheads and circuit breakers apply between services?', 'What does a user see when one service is down?', 'How are services deployed, discovered and configured?']),
          ],
          ['architecture', 'technology', 'apis', 'data', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { observability: ['logs', 'metrics', 'traces', 'alerts', 'dashboards', 'slos', 'health_checks'], testing: ['unit', 'integration', 'contract', 'e2e', 'performance'] },
        questions: { observability: ['How is one request traced across every service and message (for example OpenTelemetry context propagation)?'], testing: ['How are contracts between services tested without deploying all of them?'] },
        blocks: { plan: [phases(['Boundaries and event catalogue agreed', 'Two services and one event flow end to end', 'Tracing and dashboards across services', 'Sagas and failure handling for the core process', 'Remaining services migrated or built'])] },
        research: ['Service boundary design (bounded contexts) for this domain', 'Messaging options and their delivery guarantees', 'Saga and outbox patterns', 'Distributed tracing with OpenTelemetry', 'When a modular monolith is the better choice'],
        references: ['asyncapi', 'otel', 'c4', 'sre', 'k8s'] }),

    T('mobile', 'Mobile Application', 'apps', 'An iOS or Android app: platform approach, navigation, offline data, notifications and releases.',
      'For apps installed from app stores. Covers the native versus cross-platform choice, navigation, local data and sync, offline behaviour, push notifications, device permissions and the release process of the stores.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['App Design', ['platform', 'navigation', 'architecture', 'technology']], ['Device & Data', ['offline', 'notifications', 'apis', 'security']], ['Ship & Measure', ['releases', 'testing', 'delivery', 'observability']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('platform', 'Platform & Architecture', 'Which platforms, how the app is built for them, and how its code is organised.',
              ['Which platforms and OS versions are supported, and what share of users does that cover?', 'Native, cross-platform or a mix — what do the requirements and the team favour?', 'Which device capabilities are needed (camera, location, biometrics, background work)?']),
            S('navigation', 'Navigation & Screens', 'How users move through the app and how screens get their state.',
              ['What is the navigation structure (tabs, stacks, deep links)?', 'Which deep links and universal links must open which screens?', 'How do screens get, cache and refresh their data?'],
              [flow('Main user journey (edit)', ['Launch', 'Sign in', 'Home', 'Main task', 'Result'])]),
            S('offline', 'Local Storage & Offline', 'What works without a network and how local data syncs.',
              ['Which data is stored on the device, and how is sensitive data protected?', 'Which features must work offline, and how are changes queued and synced?', 'How are conflicts between device and server resolved?']),
            S('notifications', 'Notifications & Permissions', 'Push messages and the device permissions the app asks for.',
              ['Which notifications are sent, why, and can users control them?', 'When and how is each permission requested, and what happens if it is denied?']),
            S('releases', 'App Releases', 'Store submission, versions, rollout and updates.',
              ['How are builds signed, reviewed and submitted to each store?', 'How are staged rollouts, forced updates and old versions handled?', 'Which store policies (privacy labels, payments, content) affect the product?'],
              [check('Release checklist', ['Signing and provisioning set up', 'Privacy labels / data safety form completed', 'Crash reporting enabled', 'Staged rollout planned', 'Minimum supported version policy'])]),
          ],
          ['architecture', 'technology', 'apis', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { security: ['authentication', 'secrets', 'permissions', 'data_sensitivity', 'integrations', 'supply_chain'], testing: ['unit', 'integration', 'e2e', 'performance', 'acceptance'], deployment: ['environments', 'configuration', 'secrets', 'ci_cd'], observability: ['logs', 'metrics', 'alerts', 'dashboards'] },
        questions: { testing: ['On which real devices and OS versions are releases tested?'], observability: ['How are crashes, app-start time and battery use monitored?'] },
        blocks: { plan: [phases(['Prototype of the main journey', 'Walking skeleton on test devices', 'Offline and sync for core data', 'Notifications and permissions', 'Store submission and staged rollout'])] },
        research: ['Native versus cross-platform frameworks for these requirements', 'Offline-first sync and conflict resolution approaches', 'Current App Store and Google Play policies that apply', 'Mobile security verification (OWASP MASVS)', 'Push notification services and their limits'],
        references: ['masvs', 'asvs', 'otel'] }),

    T('desktop', 'Desktop Application', 'apps', 'A Windows, macOS or Linux app: OS integration, local services, packaging and updates.',
      'For applications installed on computers. Focuses on the desktop framework choice, local processes and IPC, filesystem and OS integration, security boundaries, code signing, packaging for each platform and automatic updates.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Application', ['framework', 'architecture', 'technology', 'data']], ['System Integration', ['os-integration', 'desktop-security', 'security']], ['Distribution', ['packaging', 'testing', 'delivery', 'observability']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('framework', 'Desktop Framework & Process Model', 'Which framework, which processes, and how they talk.',
              ['Which operating systems and versions are supported?', 'Native, web-based shell or cross-platform toolkit — what do the requirements favour?', 'Which processes exist (UI, background service, helpers) and how do they communicate (IPC)?'],
              [flow('Process model (edit)', ['User interface', 'IPC bridge', 'Local service', 'Operating system'])]),
            S('os-integration', 'Filesystem & OS Integration', 'Files, system features and integrations with the operating system.',
              ['Which folders and files does the app read and write, and how does it ask for access?', 'Which OS features are used (tray or menu bar, notifications, file associations, URL schemes, startup items)?', 'How does it behave on each OS’s conventions (shortcuts, menus, dark mode, accessibility)?']),
            S('desktop-security', 'Local Security', 'Boundaries between the UI, local services and the system.',
              ['Which privileges does each process need, and how is the rest denied?', 'How is untrusted content (web pages, files, plugins) isolated from local capabilities?', 'Where are secrets stored (OS keychain or credential store)?']),
            S('packaging', 'Packaging, Signing & Auto-Update', 'How users install, trust and update the app.',
              ['Which installer or package formats are produced per OS?', 'How are builds code-signed and, where required, notarized?', 'How are updates delivered, verified and rolled back?'],
              [check('Release checklist', ['Code signing certificates per OS', 'Notarization (macOS)', 'Installer and uninstaller tested', 'Update channel and signature verification', 'Crash reporting'])]),
          ],
          ['architecture', 'technology', 'data', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { data: ['storage', 'schemas', 'retention', 'privacy'], security: ['permissions', 'secrets', 'data_sensitivity', 'input_validation', 'supply_chain', 'integrations'], deployment: ['configuration', 'ci_cd', 'recovery'], observability: ['logs', 'metrics', 'alerts'] },
        questions: { testing: ['On which OS versions and hardware are installs, updates and uninstalls tested?'] },
        blocks: { plan: [phases(['Process model prototype on one OS', 'Core features with local storage', 'OS integrations', 'Signed installers for every OS', 'Auto-update and crash reporting'])] },
        research: ['Desktop framework options and their footprint and security models', 'IPC patterns and their security boundaries', 'Code signing and notarization requirements per OS', 'Auto-update mechanisms and how they verify updates', 'OS keychain and credential storage APIs'],
        references: ['asvs', 'ssdf', 'otel'] }),

    T('cli', 'CLI & Developer Tool', 'tools', 'A command-line tool: commands, configuration, terminal UX, plugins and distribution.',
      'For tools developers run in a terminal or in scripts. Covers command design, arguments and configuration, output that works for people and for machines, plugins, cross-platform behaviour and how the tool is installed and updated.', {
        layout: [['Product', ['overview', 'requirements']], ['Interface', ['commands', 'terminal-ux', 'configuration']], ['Internals & Extensions', ['extensibility', 'architecture', 'technology', 'components']], ['Release', ['distribution', 'security', 'testing', 'delivery']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements'],
          [
            S('commands', 'Commands & Arguments', 'The command tree, flags, arguments and exit codes.',
              ['What are the commands and subcommands, and which are used most?', 'Which flags are global, which per command, and what are the defaults?', 'Which exit codes and error messages tell scripts and people what went wrong?'],
              [table('Commands', ['Command', 'Purpose', 'Arguments / flags', 'Exit codes'])]),
            S('configuration', 'Configuration', 'Where settings come from and in which order.',
              ['Which settings exist, and where can each come from (flags, environment, project file, user file)?', 'What is the precedence order, and how can a user see the effective configuration?', 'How are credentials provided without putting them in files or shell history?']),
            S('terminal-ux', 'Terminal UX & Output', 'Output for humans and for machines.',
              ['Which output is for people (colour, progress, tables) and which for machines (JSON, quiet mode)?', 'How does the tool behave without a TTY, in CI, and with NO_COLOR?', 'How are long operations shown, cancelled and resumed?']),
            S('extensibility', 'Plugins & Extensibility', 'How others extend the tool safely.',
              ['Is a plugin system needed, and how are plugins discovered, versioned and trusted?', 'Which extension points are stable public API?']),
            S('distribution', 'Cross-Platform Support & Distribution', 'Running and installing on every target system.',
              ['Which operating systems, shells and architectures are supported?', 'How is the tool installed and updated (package managers, binaries, containers)?', 'How are releases signed and verified?']),
          ],
          ['architecture', 'technology', 'components', 'security', 'testing', 'delivery'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { security: ['secrets', 'input_validation', 'permissions', 'supply_chain'], testing: ['unit', 'integration', 'e2e', 'acceptance'], deployment: ['configuration', 'ci_cd'] },
        questions: { testing: ['How are commands tested on every supported OS and shell, including non-interactive use?'] },
        blocks: { plan: [phases(['Command tree and help text drafted', 'Core command end to end', 'Configuration and machine-readable output', 'Packaging for every platform', 'Plugins or extension points (if needed)'])] },
        research: ['Command-line interface guidelines and conventions', 'Argument-parsing and configuration libraries for the chosen language', 'Cross-platform terminal behaviour (Windows consoles, TTY detection)', 'Distribution channels and signing for CLI binaries'],
        references: ['clig', 'semver', 'slsa', 'ssdf'] }),

    T('library-sdk', 'Open-Source Library / SDK', 'tools', 'A reusable library or SDK: public API, compatibility, docs, testing and packaging.',
      'For code other developers depend on. Centres on the public API and its stability, module structure, dependency and compatibility policy, documentation, tests across supported environments, packaging and the open-source project itself.', {
        layout: [['Product', ['overview', 'requirements']], ['API Design', ['public-api', 'compatibility', 'architecture']], ['Ecosystem', ['library-deps', 'technology', 'docs']], ['Release', ['packaging-lib', 'testing', 'security', 'delivery']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements'],
          [
            S('public-api', 'Public API Design', 'What users import and call, and what stays internal.',
              ['Who uses the library, and what are the first three things they want to do?', 'What is public API and what is internal, and how is that enforced?', 'How are errors, configuration and async behaviour exposed consistently?'],
              [table('Public API surface', ['Module / entry point', 'Exports', 'Stability'])]),
            S('compatibility', 'Compatibility & Versioning', 'Which environments are supported and how changes are released.',
              ['Which language versions, runtimes and platforms are supported, and for how long?', 'How is semantic versioning applied, and what counts as a breaking change?', 'How are deprecations announced and removed?']),
            S('library-deps', 'Dependency Management', 'What the library pulls into its users’ projects.',
              ['Which runtime dependencies are unavoidable, and which can be optional or peer dependencies?', 'How are dependency updates and vulnerabilities handled?']),
            S('docs', 'Documentation & Examples', 'How users learn and how contributors join.',
              ['Which docs are needed (quick start, guides, API reference, migration notes)?', 'How are examples kept working (tested in CI)?', 'What do contributors need (contributing guide, code of conduct, issue templates, licence)?']),
            S('packaging-lib', 'Packaging & Release', 'Builds, artifacts and the release process.',
              ['Which package formats and registries are published to?', 'How are releases built reproducibly, signed and accompanied by provenance?', 'Who can publish, and how are those credentials protected?']),
          ],
          ['architecture', 'technology', 'testing', 'security', 'delivery'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { testing: ['unit', 'integration', 'contract', 'performance'], security: ['supply_chain', 'input_validation', 'secrets'], deployment: ['ci_cd'] },
        questions: { testing: ['Which matrix of runtime versions and platforms runs in CI?'] },
        blocks: { plan: [phases(['Public API sketched with examples', 'First usable release (0.x)', 'Docs site and tested examples', 'Compatibility matrix in CI', '1.0 with a stability promise'])] },
        research: ['API design conventions in the target ecosystem', 'Semantic versioning and deprecation practice', 'Supply-chain security for published packages (signing, provenance, SLSA)', 'Documentation tooling for the ecosystem'],
        references: ['semver', 'slsa', 'ssdf'] }),

    T('browser-extension', 'Browser Extension', 'apps', 'An extension for Chrome, Firefox, Edge or Safari: permissions, scripts, storage and store review.',
      'For extensions that change or extend the browser. Covers the extension architecture (background service worker, content scripts, popups), the permissions it requests, messaging, storage, security against hostile pages and the differences between browsers and their stores.', {
        layout: [['Product', ['overview', 'requirements']], ['Extension Design', ['ext-architecture', 'technology', 'ext-storage']], ['Permissions & Safety', ['permissions', 'content-scripts', 'security']], ['Release', ['browsers', 'testing', 'delivery']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements'],
          [
            S('ext-architecture', 'Extension Architecture', 'The parts of the extension and how they communicate.',
              ['Which parts are needed — background service worker, content scripts, popup, options page, side panel?', 'How do the parts message each other, and what does each one trust?', 'What happens when the background worker is suspended?'],
              [flow('Parts and messages (edit)', ['Web page', 'Content script', 'Background service worker', 'Popup / options'], [[1, 0, 'reads / changes'], [1, 2, 'messages'], [3, 2, 'messages']])]),
            S('permissions', 'Permissions', 'What the extension asks the browser for, and why.',
              ['Which permissions and host permissions are needed, and can any be optional or requested at runtime?', 'How is each permission explained to users and store reviewers?'],
              [table('Permissions', ['Permission', 'Why it is needed', 'Required or optional'])]),
            S('content-scripts', 'Content Scripts & Page Safety', 'Running inside pages the extension does not control.',
              ['On which sites does code run, and when (document start, idle, on demand)?', 'How is data from pages treated as untrusted (no evaluation, sanitized rendering)?', 'How are conflicts with page scripts and styles avoided?']),
            S('ext-storage', 'Storage & Sync', 'Where settings and data live.',
              ['Which data is stored locally, synced, or kept per session?', 'Which data is sensitive, and how is it protected or avoided?']),
            S('browsers', 'Browser Compatibility & Stores', 'Supporting several browsers and passing store review.',
              ['Which browsers and versions are supported, and what differs between them?', 'What do the stores require (privacy policy, data disclosures, review times)?']),
          ],
          ['technology', 'security', 'testing', 'delivery'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { security: ['permissions', 'input_validation', 'data_sensitivity', 'secrets', 'supply_chain'], testing: ['unit', 'integration', 'e2e'], deployment: ['ci_cd', 'configuration'] },
        blocks: { plan: [phases(['Manifest and minimal permissions', 'Core feature in one browser', 'Messaging and storage hardened', 'Other browsers', 'Store submissions'])] },
        research: ['Current extension manifest versions and their constraints per browser', 'Permission best practices and store review policies', 'Content script isolation and messaging security', 'Cross-browser extension APIs and polyfills'],
        references: ['webext', 'asvs', 'top10'] }),

    T('ecommerce', 'E-commerce / Marketplace', 'web', 'A shop or marketplace: catalogue, search, checkout, payments, orders and sellers.',
      'For selling goods or services online, by one merchant or many sellers. Covers the catalogue and search, cart and checkout, payments and their security obligations, inventory, orders and fulfilment, seller workflows and fraud.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Storefront', ['catalog', 'checkout']], ['Commerce Operations', ['orders', 'sellers']], ['Platform', ['architecture', 'technology', 'data', 'apis', 'security', 'testing', 'delivery', 'observability']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('catalog', 'Product Catalogue & Search', 'What is sold and how buyers find it.',
              ['How are products, variants, prices and availability modelled?', 'Which search, filter and sort capabilities do buyers need, and how fresh must results be?', 'Who maintains the catalogue (merchant, sellers, imports)?']),
            S('checkout', 'Cart, Checkout & Payments', 'From cart to paid order.',
              ['Which checkout steps are needed, and can guests buy?', 'Which payment methods and currencies are supported?', 'Which card data ever touches the system, and which compliance scope (PCI DSS) follows from that?', 'How are taxes, shipping costs and discounts calculated?'],
              [flow('Checkout flow (edit)', ['Cart', 'Shipping', 'Payment', 'Order placed', 'Confirmation'])]),
            S('orders', 'Orders, Inventory & Fulfilment', 'What happens after payment.',
              ['How are stock levels reserved, decremented and reconciled?', 'Which order states exist, and who moves an order between them?', 'How are cancellations, returns and refunds handled?'],
              [table('Order states', ['State', 'Entered when', 'Who acts next'])]),
            S('sellers', 'Sellers & Marketplace', 'For marketplaces: sellers, payouts and trust.',
              ['How do sellers join, list products and get verified?', 'How are payouts, commissions and disputes handled?', 'How are fraud and abuse detected?']),
          ],
          ['architecture', 'technology', 'data', 'apis', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        questions: { security: ['How is the payment flow kept out of PCI DSS scope as far as possible?', 'How are account takeover and payment fraud detected?'], testing: ['How are payment, tax and refund paths tested without real money?'] },
        blocks: { plan: [phases(['Catalogue and product pages', 'Cart and checkout with test payments', 'Orders, inventory and emails', 'Sellers and payouts (marketplace)', 'Launch with fraud monitoring'])] },
        research: ['Payment provider capabilities and PCI DSS scope reduction', 'Search options for product catalogues', 'Inventory reservation and consistency patterns', 'Tax calculation obligations for the target markets', 'Marketplace payout and seller verification requirements'],
        references: ['pci', 'asvs', 'top10', 'otel'] }),

    T('realtime', 'Real-Time / Collaborative Application', 'web', 'Live updates and shared editing: connections, sync, presence, conflicts and scale.',
      'For applications where many people see and change the same thing at once: chat, whiteboards, documents, live dashboards. Covers the real-time transport, how state is synchronised and conflicts resolved, presence, latency and scaling stateful connections.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Real-Time Core', ['transport', 'sync', 'presence']], ['Foundations', ['architecture', 'technology', 'data', 'security']], ['Scale & Operations', ['scale', 'testing', 'delivery', 'observability']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('transport', 'Connections & Transport', 'How clients and servers stay connected.',
              ['Which transport fits — WebSockets, server-sent events, WebRTC, or polling — and why?', 'How are connections authenticated, kept alive and resumed after drops?', 'What is sent: full state, operations or diffs?']),
            S('sync', 'Synchronisation & Conflict Resolution', 'How everyone ends up seeing the same state.',
              ['What is the source of truth, and how do offline edits merge?', 'Which approach fits — server-authoritative, operational transformation, or CRDTs?', 'Which conflicts can users see, and how are they shown?'],
              [flow('Edit propagation (edit)', ['Local edit', 'Send operation', 'Server orders / merges', 'Broadcast', 'Other clients apply'])]),
            S('presence', 'Presence & Awareness', 'Who is here and what they are doing.',
              ['Which presence signals are shown (online, typing, cursor, selection)?', 'How often are they sent, and how are stale ones cleared?']),
            S('scale', 'Latency & Scaling', 'Keeping it fast with many connections and rooms.',
              ['What latency is acceptable for each interaction?', 'How are connections distributed across servers, and how do servers share messages?', 'What limits apply per room, per user and per message?']),
          ],
          ['architecture', 'technology', 'data', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { testing: ['unit', 'integration', 'e2e', 'performance'], observability: ['logs', 'metrics', 'traces', 'alerts', 'slos'] },
        questions: { testing: ['How are concurrent edits, reconnects and slow networks simulated in tests?'], observability: ['Which latency and connection metrics are watched per room and per server?'] },
        blocks: { plan: [phases(['Transport prototype with reconnects', 'Shared state for one document or room', 'Conflict handling and offline edits', 'Presence', 'Load test and horizontal scaling'])] },
        research: ['Real-time transports and their browser and proxy support', 'CRDT and OT libraries and their trade-offs', 'Scaling stateful connections (pub/sub fan-out)', 'Presence protocols and rate limits'],
        references: ['crdt', 'otel', 'asvs'] }),

    T('dashboard', 'Analytics Dashboard / Internal Tool', 'web', 'Dashboards and internal tools: data sources, KPIs, visualisation, access and reports.',
      'For tools teams use to see and act on data: analytics dashboards, admin panels and back-office apps. Covers data sources and freshness, KPI definitions, visualisations and filters, row- and column-level access, exports and scheduled reports.', {
        layout: [['Product', ['overview', 'requirements']], ['Metrics & Data', ['kpis', 'sources', 'data']], ['Experience & Access', ['visualization', 'access-reports', 'security']], ['Build', ['architecture', 'technology', 'testing', 'delivery']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements'],
          [
            S('kpis', 'KPIs & Metric Definitions', 'What is measured and exactly how.',
              ['Which decisions will the dashboard support, and which KPIs inform them?', 'How is each KPI defined (formula, filters, time zone), and who owns the definition?'],
              [table('KPI definitions', ['KPI', 'Definition', 'Source', 'Owner', 'Refresh'])]),
            S('sources', 'Data Sources & Freshness', 'Where the numbers come from.',
              ['Which systems feed the tool, and how are they queried (live, replicated, warehouse)?', 'How fresh must each view be, and how is staleness shown?', 'How are slow or failed sources handled?']),
            S('visualization', 'Visualisations & Interaction', 'Charts, tables, filters and drill-down.',
              ['Which views are needed, and which chart type suits each question?', 'Which filters, drill-downs and saved views do users need?', 'How are large tables paginated, searched and exported?']),
            S('access-reports', 'Access Control & Reports', 'Who may see what, and what gets sent out.',
              ['Which roles exist, and is access needed per row or column (for example by region or customer)?', 'Which reports are scheduled or exported, to whom, and in which formats?', 'Which actions in the tool change data, and are they audited?']),
          ],
          ['architecture', 'technology', 'data', 'security', 'testing', 'delivery'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { security: ['authentication', 'authorization', 'permissions', 'data_sensitivity', 'auditability'], data: ['sources', 'schemas', 'flows', 'retention', 'privacy', 'ownership'] },
        questions: { testing: ['How are KPI calculations checked against known results?'] },
        blocks: { plan: [phases(['KPI definitions agreed with owners', 'First dashboard on real data', 'Filters, drill-down and saved views', 'Access control per role', 'Scheduled reports and exports'])] },
        research: ['Metric definition and semantic layer approaches', 'Query and caching options for interactive analytics', 'Row- and column-level security options', 'Accessible data visualisation'],
        references: ['wcag', 'asvs'] }),

    T('data-platform', 'Data Engineering / ETL-ELT Platform', 'data', 'Batch data pipelines: ingestion, transformation, orchestration, quality and lineage.',
      'For moving and shaping data for analytics and products. Covers ingestion from sources, transformation (ETL or ELT), orchestration and scheduling, storage layers, data contracts, quality checks, lineage, backfills and recovery.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Ingestion & Modelling', ['ingestion', 'transformation', 'data']], ['Reliability & Governance', ['orchestration', 'contracts-quality', 'security', 'observability']], ['Platform', ['architecture', 'technology', 'testing', 'delivery']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('ingestion', 'Ingestion', 'Getting data in from each source.',
              ['Which sources exist, how is each read (batch extract, change data capture, API, files), and how often?', 'How are schema changes in sources detected?', 'How are credentials and rate limits for sources handled?'],
              [table('Sources', ['Source', 'Method', 'Frequency', 'Volume', 'Owner'])]),
            S('transformation', 'Transformation & Modelling', 'Turning raw data into trustworthy models.',
              ['ETL or ELT — where do transformations run, and why?', 'Which layers exist (raw, cleaned, modelled), and who may use each?', 'How are transformations versioned, reviewed and tested?'],
              [flow('Data flow (edit)', ['Sources', 'Ingest', 'Raw', 'Transform', 'Modelled', 'Consumers'])]),
            S('orchestration', 'Orchestration & Recovery', 'Scheduling, dependencies, retries, backfills.',
              ['How are pipeline dependencies and schedules expressed?', 'What happens on failure — retries, alerts, partial results?', 'How are backfills and reruns made idempotent?']),
            S('contracts-quality', 'Data Contracts, Quality & Lineage', 'Agreements with producers and checks that catch bad data.',
              ['Which data contracts exist between producers and consumers?', 'Which quality checks run (freshness, volume, nulls, uniqueness, ranges), and what blocks a publish?', 'How is lineage captured so impact of a change is known?'],
              [check('Quality checks to consider', ['Freshness', 'Row volume', 'Schema', 'Nulls in required fields', 'Uniqueness of keys', 'Referential integrity', 'Value ranges'])]),
          ],
          ['architecture', 'technology', 'data', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { data: ['sources', 'schemas', 'storage', 'pipelines', 'retention', 'privacy', 'ownership'], testing: ['unit', 'integration', 'contract', 'acceptance'], observability: ['logs', 'metrics', 'alerts', 'dashboards', 'slos', 'cost_usage'] },
        questions: { security: ['Which personal or regulated data flows through the pipelines, and how is it masked, minimised or deleted?'] },
        blocks: { plan: [phases(['One source to one modelled table end to end', 'Orchestration with alerts and retries', 'Quality checks and contracts for core tables', 'Lineage and documentation', 'Remaining sources and backfills'])] },
        research: ['ETL versus ELT for these sources and volumes', 'Orchestrators and their scheduling and backfill models', 'Data quality and contract tooling', 'Lineage standards (OpenLineage)', 'Storage and table formats for analytics'],
        references: ['openlineage', 'otel'] }),

    T('streaming', 'Streaming Data Processing System', 'data', 'Event streams processed continuously: ingestion, state, windows, ordering and fault tolerance.',
      'For systems that process events as they happen: telemetry, clickstreams, payments, IoT. Covers event ingestion, stream processing topology, state and windowing, ordering and time, back-pressure, exactly-once semantics and recovery.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Streams & Processing', ['stream-ingest', 'processing', 'time']], ['Guarantees & Operations', ['fault-tolerance', 'testing', 'delivery', 'observability']], ['Platform', ['architecture', 'technology', 'data', 'security']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('stream-ingest', 'Event Ingestion', 'Events in: producers, formats, partitions.',
              ['Which producers emit which events, at what peak and average rates?', 'How are events serialised and their schemas managed?', 'How are partitions keyed, and what ordering does that give?'],
              [table('Streams', ['Stream / topic', 'Producer', 'Key', 'Rate', 'Retention'])]),
            S('processing', 'Stream Processing & State', 'The processing topology and the state it keeps.',
              ['Which processing steps exist (filter, enrich, aggregate, join), and where does each keep state?', 'How large can state grow, and how is it checkpointed and restored?'],
              [flow('Processing topology (edit)', ['Ingest', 'Validate', 'Enrich', 'Aggregate', 'Sink'])]),
            S('time', 'Time, Windows & Ordering', 'Event time versus processing time, late and out-of-order data.',
              ['Which windows are used (tumbling, sliding, session), and on which time?', 'How late may events arrive, and what happens to later ones?', 'Where is strict ordering required?']),
            S('fault-tolerance', 'Back-Pressure & Fault Tolerance', 'Surviving spikes and failures without losing or duplicating data.',
              ['What delivery guarantee does each sink need (at-least-once, effectively-once)?', 'How does the system slow producers or shed load during spikes?', 'How are reprocessing and replays done safely?']),
          ],
          ['architecture', 'technology', 'data', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { observability: ['logs', 'metrics', 'traces', 'alerts', 'dashboards', 'slos', 'cost_usage'], testing: ['unit', 'integration', 'performance', 'acceptance'] },
        questions: { observability: ['Which lag, throughput and error metrics trigger alerts?'], testing: ['How are late, duplicated and out-of-order events reproduced in tests?'] },
        blocks: { plan: [phases(['One stream processed end to end', 'State, windows and checkpoints', 'Delivery guarantees per sink', 'Load test at peak rate', 'Replay and recovery drill'])] },
        research: ['Stream processing engines and their state and checkpoint models', 'Exactly-once and idempotent sink patterns', 'Event-time windowing and watermark strategies', 'Schema registries and serialisation formats'],
        references: ['asyncapi', 'otel', 'sre'] }),

    T('mlops', 'Machine Learning / MLOps Platform', 'ai', 'Models from data to production: features, training, experiments, deployment, monitoring and retraining.',
      'For building and running machine-learning models reliably. Covers data preparation and features, training pipelines and experiment tracking, evaluation and validation gates, a model registry, serving, monitoring for drift and performance, and retraining — with reproducibility throughout.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Data & Features', ['ml-data', 'data']], ['Training & Evaluation', ['training', 'validation', 'testing']], ['Production ML', ['serving', 'ml-monitoring', 'delivery', 'observability']], ['Platform', ['architecture', 'technology', 'security']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('ml-data', 'Data Preparation & Features', 'Training data, labels and features — offline and online.',
              ['Which data and labels train the model, and how are they versioned?', 'How are features computed, and are the same definitions used for training and serving?', 'How are training/serving skew and data leakage prevented?']),
            S('training', 'Training & Experiment Tracking', 'Reproducible training and comparable experiments.',
              ['How is a training run reproduced exactly (code, data, parameters, environment, seeds)?', 'Which metrics, parameters and artifacts are tracked per experiment?', 'Which compute is used for training, and how are costs controlled?'],
              [flow('Training pipeline (edit)', ['Data snapshot', 'Feature build', 'Train', 'Evaluate', 'Register model'])]),
            S('validation', 'Evaluation & Validation Gates', 'What a model must prove before release.',
              ['Which offline metrics and thresholds must a candidate meet, against which baseline?', 'How are fairness, robustness and slices of the data checked?', 'Who approves promotion, and what is recorded?'],
              [table('Release gates', ['Check', 'Metric / method', 'Threshold', 'Owner'])]),
            S('serving', 'Model Registry & Serving', 'Versions, deployment patterns and rollback.',
              ['How are model versions registered with their lineage?', 'Batch, online or streaming inference — with which latency and throughput?', 'How are new models rolled out (shadow, canary, A/B) and rolled back?']),
            S('ml-monitoring', 'Monitoring & Retraining', 'Keeping models correct in production.',
              ['Which signals reveal decay (data drift, prediction drift, delayed labels, business metrics)?', 'What triggers retraining — schedule, drift or performance — and is it automatic?', 'How are feedback and new labels collected?']),
          ],
          ['architecture', 'technology', 'data', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { data: ['sources', 'schemas', 'storage', 'pipelines', 'retention', 'privacy', 'ownership'], testing: ['unit', 'integration', 'model_eval', 'performance', 'acceptance'], observability: ['logs', 'metrics', 'alerts', 'dashboards', 'model_metrics', 'cost_usage'] },
        questions: { security: ['Which training data is personal or licensed, and how is its use controlled?'] },
        blocks: { architecture: [check('Building blocks to consider', ['Data versioning', 'Feature pipeline / store', 'Training pipeline', 'Experiment tracking', 'Model registry', 'Serving', 'Monitoring and drift detection', 'Feedback / label collection'])], plan: [phases(['Baseline model with a reproducible run', 'Experiment tracking and validation gates', 'Registry and first deployment', 'Monitoring and alerts', 'Automated retraining'])] },
        research: ['MLOps maturity levels and continuous training', 'Experiment tracking and model registry options', 'Feature store trade-offs and training/serving skew', 'Drift detection methods', 'Responsible AI evaluation (NIST AI RMF)'],
        references: ['mlops', 'nistai', 'otel'] }),

    T('rag', 'LLM / RAG Application', 'ai', 'Answers grounded in your documents: ingestion, embeddings, retrieval, context, evaluation and guardrails.',
      'For applications that answer or act using a language model grounded in your own content. Covers document ingestion and chunking, embeddings and the index, retrieval and re-ranking, context assembly, model serving, evaluation, guardrails against misuse, and the cost and quality metrics of running it.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Knowledge', ['rag-ingestion', 'retrieval', 'data']], ['Generation & Quality', ['context-assembly', 'rag-eval', 'guardrails', 'ai']], ['Platform', ['architecture', 'technology', 'security', 'testing', 'delivery', 'observability']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('rag-ingestion', 'Document Ingestion', 'Which documents, how they are parsed, chunked and kept current.',
              ['Which sources and document types are in scope, and who may see each?', 'How are documents parsed, chunked and enriched with metadata?', 'How are updates and deletions propagated to the index?'],
              [flow('Ingestion pipeline (edit)', ['Sources', 'Parse', 'Chunk', 'Embed', 'Index'])]),
            S('retrieval', 'Embeddings & Retrieval', 'Finding the right passages for each question.',
              ['Which retrieval approach fits — vector, keyword, hybrid — and with which re-ranking?', 'How are access permissions applied at retrieval time?', 'How are embeddings versioned when the model changes?']),
            S('context-assembly', 'Context Assembly & Generation', 'Building the prompt and producing the answer.',
              ['How is the context assembled (ordering, budget, citations)?', 'Which model(s) generate answers, served how, with which fallbacks?', 'How are answers cited and uncertainty shown?']),
            S('rag-eval', 'Evaluation', 'Measuring retrieval and answer quality before and after release.',
              ['Which evaluation set represents real questions, and who maintains it?', 'Which metrics are tracked (retrieval recall, faithfulness, answer relevance, latency, cost)?', 'Which threshold must a change meet before release?'],
              [table('Evaluation metrics', ['Metric', 'Method', 'Target', 'Current'])]),
            S('guardrails', 'Guardrails & Safety', 'Preventing misuse and harmful or leaked output.',
              ['How are prompt injection, data exfiltration and jailbreak attempts handled?', 'Which content and privacy filters apply to inputs and outputs?', 'What does the system do when it should not answer?']),
          ],
          ['architecture', 'technology', 'ai', 'data', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { ai: ['models', 'knowledge', 'context', 'retrieval', 'vector_stores', 'prompt_boundaries', 'evaluation', 'guardrails', 'fallbacks'], testing: ['unit', 'integration', 'model_eval', 'security', 'acceptance'], observability: ['logs', 'traces', 'alerts', 'ai_metrics', 'cost_usage'] },
        questions: { security: ['Which OWASP Top 10 for LLM Applications risks apply, and how is each mitigated?'] },
        blocks: { architecture: [check('Building blocks to consider', ['Ingestion pipeline', 'Chunking and metadata', 'Embedding service', 'Vector / hybrid index', 'Retriever and re-ranker', 'Context assembler', 'Model gateway', 'Evaluation harness', 'Guardrails', 'Tracing and cost metering'])], plan: [phases(['Evaluation set of real questions', 'Baseline retrieval and answers measured', 'Retrieval improvements against the evaluation set', 'Guardrails and permission-aware retrieval', 'Production monitoring of quality and cost'])] },
        research: ['Chunking and hybrid retrieval strategies for these document types', 'Embedding and re-ranking model options', 'RAG evaluation methods and tooling', 'OWASP Top 10 for LLM Applications', 'LLM observability (tracing, cost, quality)'],
        references: ['llm', 'nistai', 'otel', 'asvs'] }),

    T('agentic', 'Agentic AI / Multi-Agent / MCP System', 'ai', 'Agents that use tools: roles, MCP servers, skills, orchestration, memory, permissions and evaluation.',
      'For systems where AI agents plan and act with tools, alone or together. Covers agent roles and responsibilities, tools and Model Context Protocol servers, skills and instructions, orchestration patterns, context and memory, permission boundaries and human approval, and evaluating agent behaviour.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Agents & Capabilities', ['roles', 'tools-mcp', 'ai']], ['Orchestration & Memory', ['orchestration', 'memory']], ['Trust & Evaluation', ['agent-eval', 'security', 'testing', 'observability']], ['Platform', ['architecture', 'technology', 'delivery']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('roles', 'Agent Roles & Responsibilities', 'Which agents exist and what each one may decide.',
              ['Is one agent enough, or do distinct roles justify several — and why?', 'What is each agent responsible for, and what is it explicitly not allowed to do?', 'Which decisions always need a person?'],
              [table('Agents', ['Agent', 'Responsibility', 'Tools', 'Needs approval for'])]),
            S('tools-mcp', 'Tools, MCP Servers & Skills', 'What agents can do and how capabilities are provided.',
              ['Which tools does each agent need, and which are read-only versus able to change things?', 'Which capabilities come from MCP servers, and over which transport (stdio, Streamable HTTP)?', 'Which reusable skills or instructions does each agent load, and when?', 'How are tool schemas validated and tool results treated as untrusted input?']),
            S('orchestration', 'Orchestration', 'How work is planned, delegated and finished.',
              ['Which pattern fits — single loop, router, planner and workers, or hand-offs?', 'How are long tasks checkpointed, resumed and stopped?', 'How are budgets (tokens, time, cost, steps) enforced?'],
              [flow('Orchestration (edit)', ['Request', 'Plan', 'Delegate to agent', 'Use tools', 'Review result', 'Respond'])]),
            S('memory', 'Context & Memory', 'What agents know, remember and forget.',
              ['Which context does each agent get at the start, and how is it kept within budget?', 'What is remembered between sessions, where, and how is it corrected or deleted?', 'How is sensitive data kept out of prompts and memory?']),
            S('agent-eval', 'Evaluation & Safety', 'Proving agents do the right thing safely.',
              ['Which tasks make up the evaluation suite, and how is success judged?', 'How are tool misuse, prompt injection and runaway loops detected and contained?', 'Which actions are logged for audit?'],
              [check('Safety controls to consider', ['Least-privilege tool permissions', 'Human approval for irreversible actions', 'Sandboxed execution', 'Step and cost limits', 'Untrusted-content handling', 'Audit log of tool calls'])]),
          ],
          ['architecture', 'technology', 'ai', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { ai: ['models', 'agents', 'tools', 'mcps', 'knowledge', 'context', 'memory', 'prompt_boundaries', 'orchestration', 'evaluation', 'guardrails', 'fallbacks'], testing: ['unit', 'integration', 'agent_eval', 'model_eval', 'security'], observability: ['logs', 'traces', 'alerts', 'ai_metrics', 'cost_usage'] },
        questions: { security: ['Which agent actions are irreversible, and how is each gated?', 'How is a tool result containing instructions prevented from steering the agent?'] },
        blocks: { plan: [phases(['One agent, one tool, one task end to end', 'Evaluation suite with success criteria', 'Permissions and approvals for risky actions', 'Additional tools / MCP servers', 'Multiple agents (only if evaluation shows the need)'])] },
        research: ['Agent orchestration patterns and when multi-agent setups help', 'Model Context Protocol transports, authorization and tool safety', 'Agent evaluation methods and benchmarks', 'Prompt injection defences for tool-using agents', 'Memory designs for agents'],
        references: ['mcp', 'llm', 'nistai', 'otel'] }),

    T('cloud-platform', 'Cloud Infrastructure / Platform Engineering', 'infrastructure', 'Infrastructure and an internal platform: IaC, Kubernetes, GitOps, CI/CD, security and cost.',
      'For the infrastructure and internal developer platform other teams build on. Covers cloud account and network design, infrastructure as code, container orchestration, GitOps and CI/CD, golden paths for teams, security and policy, observability and cost management.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Foundations', ['cloud-architecture', 'iac', 'architecture', 'technology', 'security']], ['Runtime & Delivery', ['runtime-platform', 'gitops', 'delivery']], ['Operations & Cost', ['observability', 'finops', 'testing']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('cloud-architecture', 'Cloud Architecture & Networking', 'Accounts, regions, networks and connectivity.',
              ['How are accounts, projects or subscriptions organised per environment and team?', 'Which regions and availability zones are used, and why?', 'How are networks segmented, and how does traffic enter and leave?']),
            S('iac', 'Infrastructure as Code', 'Describing and changing infrastructure safely.',
              ['Which infrastructure is defined as code, and how are changes reviewed and applied?', 'How are state, drift and secrets handled?', 'Which reusable modules form the building blocks?']),
            S('runtime-platform', 'Kubernetes & Runtime', 'Where workloads run and how they are managed.',
              ['Which workloads need Kubernetes, and which fit serverless or managed services better?', 'How are clusters provisioned, upgraded and multi-tenanted?', 'Which defaults does every workload get (limits, probes, policies)?']),
            S('gitops', 'GitOps & Golden Paths', 'How teams ship through the platform.',
              ['How do changes flow from commit to environment (GitOps, pipelines, promotion)?', 'Which golden paths or templates do teams start from?', 'How do teams self-serve without filing tickets?'],
              [flow('Delivery path (edit)', ['Commit', 'CI: build and test', 'Artifact', 'GitOps repository', 'Environment'])]),
            S('finops', 'Cost Management', 'Knowing and controlling what the platform costs.',
              ['How is cost attributed to teams and services (tags, labels)?', 'Which budgets and alerts exist?', 'Which optimisations are routine (rightsizing, autoscaling, commitments)?']),
          ],
          ['architecture', 'technology', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { security: ['authentication', 'authorization', 'secrets', 'permissions', 'network_exposure', 'supply_chain', 'auditability'], deployment: ['environments', 'runtime', 'containers', 'infrastructure', 'hosting', 'configuration', 'secrets', 'networking', 'scaling', 'backups', 'recovery', 'ci_cd'], observability: ['logs', 'metrics', 'traces', 'alerts', 'dashboards', 'slos', 'health_checks', 'cost_usage'] },
        questions: { testing: ['How are infrastructure changes tested before production (plans, policy checks, staging)?'], security: ['Which policies are enforced automatically (admission control, policy as code)?'] },
        blocks: { plan: [phases(['Landing zone: accounts, network, identity', 'IaC modules and pipelines', 'Runtime platform for one team', 'GitOps and golden path', 'Observability, policy and cost reporting'])] },
        research: ['Landing-zone and account structure guidance from the cloud provider', 'Infrastructure-as-code tools and state management', 'Kubernetes platform patterns and multi-tenancy', 'GitOps tooling', 'Platform engineering and internal developer portals', 'FinOps practices'],
        references: ['cncf', 'k8s', 'otel', 'slsa', 'sre', 'twelve'] }),

    T('iot-edge', 'IoT / Edge Computing System', 'infrastructure', 'Connected devices and edge processing: protocols, telemetry, fleet management, OTA and security.',
      'For systems of physical devices and the software around them. Covers device hardware and firmware constraints, communication protocols and connectivity, telemetry, edge processing, device provisioning and fleet management, over-the-air updates and device security.', {
        layout: [['Product', ['overview', 'requirements', 'quality']], ['Devices & Connectivity', ['devices', 'protocols', 'ota']], ['Data & Edge', ['telemetry', 'data']], ['Fleet & Security', ['fleet', 'security']], ['Platform', ['architecture', 'technology', 'testing', 'delivery', 'observability']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements', 'quality'],
          [
            S('devices', 'Devices & Firmware', 'The hardware, its limits and the software on it.',
              ['Which devices are involved, with which compute, memory, power and lifetime constraints?', 'Which firmware or OS runs on them, and who maintains it?']),
            S('protocols', 'Protocols & Connectivity', 'How devices talk to each other and to the cloud.',
              ['Which protocols fit (for example MQTT, CoAP, HTTP, BLE), and why?', 'How do devices behave with intermittent or expensive connectivity?', 'How are messages buffered, ordered and retried?']),
            S('telemetry', 'Telemetry & Edge Processing', 'What is measured, processed locally and sent.',
              ['Which telemetry is collected, how often, and at what volume per device?', 'What must be processed at the edge (latency, privacy, bandwidth), and what in the cloud?'],
              [flow('Data path (edit)', ['Sensor', 'Device', 'Edge gateway', 'Cloud ingestion', 'Storage and apps'])]),
            S('fleet', 'Provisioning & Fleet Management', 'Bringing devices online and keeping them healthy.',
              ['How are devices provisioned with identities and credentials at manufacture or install?', 'How are device health, configuration and inventory managed?', 'How are devices decommissioned?']),
            S('ota', 'Over-the-Air Updates', 'Updating firmware and software safely in the field.',
              ['How are updates signed, delivered and verified on the device?', 'How are rollouts staged, and how does a device recover from a failed update?'],
              [check('OTA safeguards to consider', ['Signed images', 'A/B partitions or rollback', 'Staged rollout', 'Power-loss safety', 'Update telemetry'])]),
          ],
          ['architecture', 'technology', 'data', 'security', 'testing', 'delivery', 'observability'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { security: ['authentication', 'secrets', 'permissions', 'data_sensitivity', 'threats', 'supply_chain', 'network_exposure'], testing: ['unit', 'integration', 'e2e', 'performance', 'acceptance'] },
        questions: { security: ['How is each device identified and authenticated, and how are compromised devices revoked?'], testing: ['How are devices tested in the lab under poor connectivity and power loss?'] },
        blocks: { plan: [phases(['One device sending telemetry end to end', 'Provisioning and device identity', 'Edge processing', 'OTA updates with rollback', 'Fleet management at pilot scale'])] },
        research: ['IoT protocols and their trade-offs for these constraints', 'Device identity and provisioning approaches', 'OTA update frameworks and safety mechanisms', 'IoT security guidance (OWASP IoT)', 'Edge runtime options'],
        references: ['iotsec', 'otel'] }),

    T('game', 'Game / Interactive Simulation', 'apps', 'A game or simulation: engine, game loop, world systems, rendering, physics, assets, input and networking.',
      'For games and interactive simulations. Covers the engine decision, game loop and architecture, world and gameplay systems, rendering and physics, asset pipelines, input across devices, multiplayer networking and performance budgets per platform.', {
        layout: [['Game Design', ['overview', 'requirements', 'world']], ['Technology', ['engine', 'rendering-physics', 'architecture', 'technology']], ['Content & Input', ['assets', 'input-network']], ['Quality & Release', ['game-performance', 'testing', 'delivery']], ['Plan', ['decisions', 'risks', 'roadmap']]],
        pool: [
          ['overview', 'requirements'],
          [
            S('engine', 'Engine & Game Architecture', 'Engine choice, game loop and how systems are organised.',
              ['Which platforms are targeted, and what does that imply for the engine?', 'Use an existing engine or build one — what do the requirements and team favour?', 'How are game systems organised (entity-component systems, scenes, scripts)?']),
            S('world', 'World & Gameplay Systems', 'The rules and content of the game world.',
              ['What is the core gameplay loop, in one sentence?', 'Which systems make the world (movement, combat, economy, AI characters, progression)?', 'How is game data (levels, items, balance) authored and tuned?'],
              [flow('Core loop (edit)', ['Goal', 'Action', 'Feedback', 'Reward'], [[0, 1], [1, 2], [2, 3], [3, 0, 'next goal']])]),
            S('rendering-physics', 'Rendering & Physics', 'What it looks like and how things move.',
              ['Which art style and rendering techniques are needed, and on which minimum hardware?', 'Which physics are needed, and must they be deterministic?']),
            S('assets', 'Assets & Content Pipeline', 'From artist tools to the build.',
              ['Which asset types exist, and how do they get from source tools into the game?', 'How are assets versioned, compressed and streamed?']),
            S('input-network', 'Input & Networking', 'Controls and multiplayer.',
              ['Which input devices are supported, and can controls be remapped?', 'Is there multiplayer — which model (peer-to-peer, client-server, authoritative server, rollback)?', 'How are cheating and latency handled?']),
            S('game-performance', 'Performance Budgets', 'Frame time, memory and loading per platform.',
              ['What frame rate and frame-time budget per platform?', 'What memory, download and loading-time limits apply?'],
              [table('Performance budget', ['Platform', 'Frame time', 'Memory', 'Load time'])]),
          ],
          ['architecture', 'technology', 'testing', 'delivery'],
          ['decisions', 'risks', 'roadmap'],
        ],
        topics: { testing: ['unit', 'integration', 'performance', 'acceptance'], deployment: ['ci_cd', 'configuration'] },
        questions: { testing: ['How are gameplay, performance on minimum hardware, and saves tested?'] },
        blocks: { plan: [phases(['Playable prototype of the core loop', 'Vertical slice with final-quality assets', 'Content production', 'Multiplayer / platform features', 'Optimisation and certification'])] },
        research: ['Engine options for the target platforms and team', 'Multiplayer networking models and their trade-offs', 'Asset pipeline tooling', 'Platform certification requirements'],
        references: [] }),
  ];

  const byId = new Map(TEMPLATES.map(template => [template.id, template]));
  /** The sections a template adds, by key, in order: built-in ones by their ID, its own by their key. */
  function templateSections(template) {
    return template.categories.flatMap(category => category.sections.map(ref => {
      if (typeof ref !== 'string') return { key: ref.key, title: ref.title, own: true, category: category.title, section: ref };
      const module = MODULES[ref];
      return { key: module.section || ref, title: module.title, own: !module.section, category: category.title, module: ref };
    }));
  }
  return { VERSION, CATEGORIES, MODULES, TEMPLATES, get: id => byId.get(id) || null, templateSections };
})();
