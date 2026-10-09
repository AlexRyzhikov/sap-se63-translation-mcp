"! Exception for the MCP translation service.
"! Carries a plain text and the HTTP status the ICF handler should return.
CLASS zcx_mcp_transl DEFINITION
  PUBLIC
  INHERITING FROM cx_static_check
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    DATA mv_text        TYPE string READ-ONLY.
    DATA mv_http_status TYPE i READ-ONLY.

    METHODS constructor
      IMPORTING
        textid         LIKE textid OPTIONAL
        previous       LIKE previous OPTIONAL
        iv_text        TYPE string OPTIONAL
        iv_http_status TYPE i DEFAULT 400.

    METHODS get_text REDEFINITION.

  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.



CLASS zcx_mcp_transl IMPLEMENTATION.

  METHOD constructor ##ADT_SUPPRESS_GENERATION.
    super->constructor( textid = textid previous = previous ).
    mv_text        = iv_text.
    mv_http_status = iv_http_status.
  ENDMETHOD.


  METHOD get_text.
    IF mv_text IS NOT INITIAL.
      result = mv_text.
    ELSE.
      result = super->get_text( ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
