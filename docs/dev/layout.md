# Layout & Dashboard Component Integration

## **Overview**

The main frontend layout is in `app/src/cmp/App.tsx`. It manages:
- Top-level page switching between **About**, **Repositories**, and **Organizations** using pill buttons (`NavBar`)
- Collapsible filter sidebar (`SidebarFilters`)
- Secondary tab navigation for sub-views using tab buttons (`NavBar`)
- Main content area which renders active views

---

## **How to add a new dashboard component**

When implementing a new dashboard component (e.g., Browse, Impact, Sustainability, Security):

1. **Create the component** under `app/src/cmp/dash/<DashboardName>.tsx`
2. **Import it** in `app/src/cmp/App.tsx`:
    - `import DashboardName from './dash/DashboardName';`
3. **Render it** conditionally inside the tab-view container:
    - `{repoTab === 'Overview' && <Overview/>}`
    - `{repoTab === 'DashboardName' && <DashboardName/>}`

---

### Styling Notes

- Use `width: 100%` for top-level dashboard containers so they cleanly fit within the whole content area
- For flex containers for wide tables or charts, set `min-width: 0` to prevent unnecessary horizontal page scrolling

---

## Browse Organizations Dashboard

The Browse Organizations dashboard is implemented in `app/src/cmp/dash/browseOrgs.tsx` and is displayed under the Organizations → Browse tab.

- Uses the `DataTable` component to display organization data from the `/organization/organizations` API endpoint.
- Supports searching, downloading organization data, and filtering by university and prediction threshold.
- Allows users to click on an organization row to view additional details below the table.
- Displays the organization's name, university affiliation, and whether a URL, description, and email are available.
- Uses the existing organization filters managed in `App.tsx`.

Tests for this dashboard are located in `app/src/tests/cmp/dash/browseOrgs.test.tsx`.