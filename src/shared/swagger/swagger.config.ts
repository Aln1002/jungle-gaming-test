import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

const darkTheme = `
  body, .swagger-ui { background: #111827; color: #e5e7eb; }
  .swagger-ui .topbar { background: #0b1220; }
  .swagger-ui .info .title, .swagger-ui .info p, .swagger-ui .info li,
  .swagger-ui .info h1, .swagger-ui .info h2, .swagger-ui .info h3,
  .swagger-ui .scheme-container, .swagger-ui .opblock-tag,
  .swagger-ui .opblock .opblock-summary-description,
  .swagger-ui .opblock .opblock-summary-operation-id,
  .swagger-ui .opblock .opblock-summary-path, .swagger-ui .opblock .opblock-summary-path__deprecated,
  .swagger-ui .opblock-description-wrapper p, .swagger-ui .opblock-external-docs-wrapper p,
  .swagger-ui .opblock-title_normal, .swagger-ui .parameter__name,
  .swagger-ui .parameter__type, .swagger-ui .parameter__in,
  .swagger-ui .response-col_status, .swagger-ui .response-col_description,
  .swagger-ui .response-col_links, .swagger-ui .tab li, .swagger-ui label,
  .swagger-ui .model-title, .swagger-ui .model, .swagger-ui section.models h4,
  .swagger-ui table thead tr th, .swagger-ui table thead tr td { color: #e5e7eb; }
  .swagger-ui .scheme-container, .swagger-ui .opblock .opblock-section-header,
  .swagger-ui section.models, .swagger-ui .model-box { background: #1f2937; }
  .swagger-ui .opblock .opblock-section-header h4 { color: #f3f4f6; }
  .swagger-ui input, .swagger-ui textarea, .swagger-ui select {
    background: #f9fafb; color: #111827;
  }
  .swagger-ui .btn { color: #e5e7eb; border-color: #9ca3af; }
  .swagger-ui .btn.execute, .swagger-ui .btn.authorize { color: #fff; }
  .swagger-ui svg { fill: #e5e7eb; }
  .swagger-ui .dialog-ux .modal-ux { background: #1f2937; }
  .swagger-ui .dialog-ux .modal-ux-header h3,
  .swagger-ui .dialog-ux .modal-ux-content p,
  .swagger-ui .dialog-ux .modal-ux-content h4 { color: #e5e7eb; }
`;

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor')
    .setDescription(
      'Development API documentation. Business endpoints require an OIDC access token.',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'Wagering API Docs',
    customCss: darkTheme,
    swaggerOptions: { persistAuthorization: false },
  });
}
