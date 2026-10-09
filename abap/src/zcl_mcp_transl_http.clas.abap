"! ICF handler for the MCP translation service.
"! SICF node e.g. /sap/bc/zmcp_transl  ->  POST /sap/bc/zmcp_transl/{action}
"! Body and response are JSON. All logic lives in ZCL_MCP_TRANSL_API.
CLASS zcl_mcp_transl_http DEFINITION
  PUBLIC
  FINAL
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_http_extension.

  PROTECTED SECTION.
  PRIVATE SECTION.
    METHODS respond
      IMPORTING
        io_server TYPE REF TO if_http_server
        iv_status TYPE i
        iv_json   TYPE string.

    METHODS error_json
      IMPORTING iv_text        TYPE string
      RETURNING VALUE(rv_json) TYPE string.

ENDCLASS.



CLASS zcl_mcp_transl_http IMPLEMENTATION.

  METHOD if_http_extension~handle_request.
    DATA lv_json   TYPE string.
    DATA lv_action TYPE string.

    if_http_extension~flow_rc = if_http_extension=>co_flow_ok.

    IF server->request->get_method( ) <> 'POST'.
      respond( io_server = server iv_status = 405 iv_json = error_json( `Use HTTP POST` ) ).
      RETURN.
    ENDIF.

    " Only users who may run SE63 may use this service.
    AUTHORITY-CHECK OBJECT 'S_TCODE' ID 'TCD' FIELD 'SE63'.
    IF sy-subrc <> 0.
      respond( io_server = server iv_status = 403
               iv_json   = error_json( |User { sy-uname } has no authorization for SE63| ) ).
      RETURN.
    ENDIF.

    lv_action = to_lower( server->request->get_header_field( '~path_info' ) ).
    lv_action = shift_left( val = lv_action sub = `/` ).

    TRY.
        lv_json = NEW zcl_mcp_transl_api( )->handle(
                    iv_action = lv_action
                    iv_body   = server->request->get_cdata( ) ).
        respond( io_server = server iv_status = 200 iv_json = lv_json ).

      CATCH zcx_mcp_transl INTO DATA(lx_transl).
        ROLLBACK WORK.
        respond( io_server = server iv_status = lx_transl->mv_http_status
                 iv_json   = error_json( lx_transl->get_text( ) ) ).

      CATCH cx_root INTO DATA(lx_root).
        ROLLBACK WORK.
        respond( io_server = server iv_status = 500
                 iv_json   = error_json( |{ cl_abap_classdescr=>get_class_name( lx_root ) }: { lx_root->get_text( ) }| ) ).
    ENDTRY.
  ENDMETHOD.


  METHOD respond.
    io_server->response->set_status( code   = iv_status
                                     reason = COND #( WHEN iv_status = 200 THEN `OK` ELSE `Error` ) ).
    io_server->response->set_content_type( `application/json; charset=utf-8` ).
    io_server->response->set_cdata( iv_json ).
  ENDMETHOD.


  METHOD error_json.
    rv_json = `{"error":"` && escape( val = iv_text format = cl_abap_format=>e_json_string ) && `"}`.
  ENDMETHOD.

ENDCLASS.
