-- ===========================================================================
-- 004_lead_project_attribution.sql
--
-- Every enquiry should be attached to a project, so the two automated sources
-- that had no way to express one now carry it.
--
--   meta_lead_forms.project_id   OPTIONAL. Chosen when a Meta form is
--                                connected. Left empty, its leads arrive with
--                                no project and appear under the "No project"
--                                filter - which is far better than refusing a
--                                paid-for lead at the door.
--
--   import_jobs.project_id       Recorded for the run. The API requires one for
--                                a lead import, so this is what was applied to
--                                every row, kept for the import history.
--
-- Both are ON DELETE SET NULL: deleting a project must never take an enquiry
-- or an import record with it.
--
-- MySQL 5.7+ / MariaDB 10.3+ safe: nullable columns, no defaults needed.
-- ===========================================================================

ALTER TABLE meta_lead_forms
  ADD COLUMN project_id CHAR(25) NULL AFTER source_id,
  ADD CONSTRAINT fk_metaform_project FOREIGN KEY (project_id)
      REFERENCES projects(id) ON DELETE SET NULL;

ALTER TABLE import_jobs
  ADD COLUMN project_id CHAR(25) NULL AFTER entity,
  ADD CONSTRAINT fk_import_project FOREIGN KEY (project_id)
      REFERENCES projects(id) ON DELETE SET NULL;
