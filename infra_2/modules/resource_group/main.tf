resource "aws_resourcegroups_group" "this" {
  name = var.group_name

  resource_query {
    query = jsonencode({
      ResourceTypeFilters = ["AWS::AllSupported"]
      TagFilters = [
        {
          Key    = "Project"
          Values = [var.project_tag_value]
        },
        {
          Key    = "Environment"
          Values = [var.environment_tag_value]
        }
      ]
    })
  }

  tags = var.tags
}
